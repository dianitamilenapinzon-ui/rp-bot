import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// ===== ENV VARS =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WABA_TOKEN = process.env.WABA_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ALERT_WHATSAPP_TO = process.env.ALERT_WHATSAPP_TO;
const TIMEZONE = process.env.TIMEZONE || "America/Bogota";
const BUSINESS_START = Number(process.env.BUSINESS_START || 9);
const BUSINESS_END = Number(process.env.BUSINESS_END || 18);

// ===== HELPERS =====
function isBusinessHours(date = new Date()) {
  const now = new Date(date.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const hour = now.getHours();
  return hour >= BUSINESS_START && hour < BUSINESS_END;
}

async function waSendText(to, text) {
  await fetch(`https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WABA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
}

async function sendWhatsAppAlert(text) {
  const to = ALERT_WHATSAPP_TO;
  if (!to) return;
  await waSendText(to, `🔔 Alerta RP-Bot:\n${text}`);
}

async function notifyAlert({ tipo, from, nombre, producto, codigo, direccion, ciudad, nota }) {
  const resumen =
`🔔 ${tipo}
Cliente: ${from}
Nombre: ${nombre || "-"}
Producto: ${producto || "-"} (${codigo || "-"})
Dirección: ${direccion || "-"}
Ciudad: ${ciudad || "-"}
Nota: ${nota || "-"}
Hora: ${new Date().toLocaleString("es-CO", { timeZone: TIMEZONE })}`;
  await sendWhatsAppAlert(resumen);
}

// ===== SESSION (tarjeta libre y formularios) =====
const session = new Map();
function setAwaitingCard(from, value=true){ session.set(from,{...(session.get(from)||{}), awaitingCard:value}); }
function isAwaitingCard(from){ return !!(session.get(from)||{}).awaitingCard; }
function setForm(from, obj){ session.set(from,{...(session.get(from)||{}), form: obj}); }
function getForm(from){ return (session.get(from)||{}).form; }
function clearForm(from){ const s=session.get(from)||{}; delete s.form; session.set(from,s); }

// ===== INVENTARIO DESDE SHEET (GVIZ CSV) =====
let _invCache = { at: 0, rows: [] };
async function loadInventoryCSV() {
  const url = process.env.INVENTORY_CSV_URL;
  if (!url) return [];
  const now = Date.now();
  const ttl = Number(process.env.INVENTORY_CACHE_SECONDS || 120) * 1000;
  if (ttl > 0 && (now - _invCache.at) < ttl && _invCache.rows.length) {
    return _invCache.rows;
  }
  const resp = await fetch(url);
  const csv = await resp.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const [header, ...rows] = lines;
  const idx = {};
  header.split(",").forEach((h,i)=> idx[h.trim().toLowerCase()] = i);
  const data = rows.map(r=>{
    const cols = r.split(",");
    const get = (k)=> (cols[idx[k]]||"").trim();
    return {
      code: get("code"),
      name: get("name"),
      stock: Number(get("stock")||0),
      price: Number(get("price")||0)
    };
  }).filter(x => x.code || x.name);
  _invCache = { at: now, rows: data };
  return data;
}
function findItemByText(inv, text="") {
  const t = (text||"").toLowerCase();
  return inv.find(i =>
    t.includes((i.code||"").toLowerCase()) ||
    t.includes((i.name||"").toLowerCase())
  );
}
function inStock(item){ return item && Number(item.stock) > 0; }

// ===== FUNCIONES DINÁMICAS DESDE SHEET =====
let _funcCache = { at: 0, rows: [] };
async function loadFunctionsCSV() {
  const url = process.env.FUNCTIONS_CSV_URL;
  if (!url) return [];
  const now = Date.now();
  const ttl = Number(process.env.FUNCTIONS_CACHE_SECONDS || 120) * 1000;
  if (ttl > 0 && (now - _funcCache.at) < ttl && _funcCache.rows.length) {
    return _funcCache.rows;
  }
  const resp = await fetch(url);
  const csv = await resp.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const [header, ...rows] = lines;
  const idx = {};
  header.split(",").forEach((h,i)=> idx[h.trim().toLowerCase()] = i);
  const data = rows.map(r=>{
    const cols = r.split(",");
    const get = (k)=> (cols[idx[k]]||"").trim();
    return {
      enabled: (get("enabled")||"").toLowerCase().startsWith("y"),
      type: (get("type")||"").toUpperCase(),
      trigger: get("trigger"),
      p1: get("payload1"),
      p2: get("payload2")
    };
  }).filter(x => x.type && x.trigger);
  _funcCache = { at: now, rows: data };
  return data;
}

async function tryHandleDynamicFeature(from, text) {
  const funcs = await loadFunctionsCSV();
  const lower = (text||"").toLowerCase();
  for (const f of funcs) {
    if (!f.enabled) continue;
    let match = false;
    if (f.trigger.startsWith("=")) {
      match = lower === f.trigger.slice(1).toLowerCase();
    } else {
      match = lower.includes(f.trigger.toLowerCase());
    }
    if (!match) continue;

    if (f.type === "TEXT") {
      await waSendText(from, f.p1 || ""); 
      if (f.p2) await notifyAlert({ tipo:"Función TEXT", from, nota:f.p2 });
      return true;
    }

    if (f.type === "ALERT") {
      await notifyAlert({ tipo: f.p1 || "Alerta", from, nota: f.p2 || "" });
      await waSendText(from, "✅ Aviso enviado. ¿Te ayudo con algo más?");
      return true;
    }

    if (f.type === "FORM") {
      const fields = (f.p1||"").split("|").map(s=>s.trim()).filter(Boolean);
      if (!fields.length){ return false; }
      setForm(from, { title: f.trigger, fields, i: 0, data: {}, thanks: f.p2||"¡Listo! Gracias." });
      await waSendText(from, `Por favor responde:\n• ${fields.join("\n• ")}`);
      await waSendText(from, `👉 Empecemos con: *${fields[0]}*`);
      return true;
    }
  }
  return false;
}

async function handleFormIfAny(from, text){
  const f = getForm(from);
  if (!f) return false;
  const currentField = f.fields[f.i];
  f.data[currentField] = text;
  f.i += 1;
  if (f.i < f.fields.length) {
    const nextField = f.fields[f.i];
    setForm(from, f);
    await waSendText(from, `Gracias. Ahora: *${nextField}*`);
  } else {
    await waSendText(from, f.thanks);
    const resumen = Object.entries(f.data).map(([k,v])=>`${k}: ${v}`).join("\n");
    await notifyAlert({ tipo:`Formulario: ${f.title}`, from, nota: resumen });
    clearForm(from);
  }
  return true;
}

// ===== WEBHOOKS =====
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if(mode && token && mode==="subscribe" && token===VERIFY_TOKEN){
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req,res)=>{
  const body = req.body;
  if(body.object){
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    if(messages && messages[0]){
      const msg = messages[0];
      const from = msg.from;
      const type = msg.type;
      const text = type==="text"? (msg.text?.body||"").trim() : "";
      const lower = text.toLowerCase();

      if(!isBusinessHours()){
        await waSendText(from,
          "🕘 Nuestro horario es de 9:00 a.m. a 6:00 p.m.\n" +
          "Tu pedido quedará programado para las 6:00 a.m. 📅"
        );
        return res.sendStatus(200);
      }

      if(type==="text" && isAwaitingCard(from)){
        let customText = text;
        if(customText.length>500) customText = customText.slice(0,500);
        await waSendText(from, `Perfecto, tu tarjeta personalizada será:\n“${customText}” 💌✅`);
        await notifyAlert({ tipo:"Tarjeta personalizada", from, nota: customText });
        session.set(from, {...(session.get(from)||{}), awaitingCard:false});
        await waSendText(from,"Para confirmar, regálame por favor:\n• Nombre\n• Fecha y hora de la entrega\n• Ubicación y dirección");
        return res.sendStatus(200);
      }

      if (type==="text" && await handleFormIfAny(from, text)) {
        return res.sendStatus(200);
      }

      if(["hola","menu","menú","inicio","start"].includes(lower)){
        await waSendText(from,
          "👋 Bienvenido a *Tienda de Regalos RP*\n" +
          "1️⃣ Favoritos\n" +
          "2️⃣ Entregas hoy\n" +
          "3️⃣ Mayoristas\n\n" +
          "Todos nuestros productos incluyen 🎀 moño, 🎈 globo y 💌 tarjeta personalizada."
        );
        return res.sendStatus(200);
      }

      if(lower==="1"){
        await waSendText(from,
          "⭐ Favoritos RP:\n• Oso gigante 1m\n• Stitch 40cm\n• Hello Kitty\n• Capibara\n• Flores eternas\n\n" +
          "🎀 Incluyen moño + globo + tarjeta.\n" +
          "¿Qué globo prefieres? 🎈 (Feliz Día / Te Amo / Feliz Cumpleaños)\n" +
          "Si deseas, escribe tu mensaje de tarjeta (máx. 500)."
        );
        setAwaitingCard(from,true);
        return res.sendStatus(200);
      }

      if(type==="text" && text){
        try{
          const inv = await loadInventoryCSV();
          const item = findItemByText(inv, text);
          if (item){
            if(!inStock(item)){
              await waSendText(from,
                `⚠️ ${item.name} está sin stock en este momento.\n` +
                `Un asesor de bodega te contactará para revisar alternativas.`
              );
              await notifyAlert({ tipo:"Sin stock", from, producto:item.name, codigo:item.code, nota:"Inventario sin stock" });
              return res.sendStatus(200);
            } else {
              await waSendText(from, `✅ ${item.name} está disponible.`);
              if (item.price > 0){
                const price = item.price.toLocaleString("es-CO");
                await waSendText(from, `Precio de referencia: $${price}`);
              }
              await waSendText(from, "Para confirmar, regálame por favor:\n• Nombre\n• Fecha y hora de la entrega\n• Ubicación y dirección");
              return res.sendStatus(200);
            }
          }
        }catch(e){
          console.error("Inventario CSV error:", e.message);
        }
      }

      const CLOSE_INTENT = ["lo compro","comprar","confirmo","resérvame","enviar","pago contraentrega","lo quiero","se entrega a las"];
      if(CLOSE_INTENT.some(k=>lower.includes(k))){
        await notifyAlert({ tipo:"Intento de cierre", from, nota:"Cliente quiere comprar" });
        await waSendText(from,"Perfecto 🙌 Para confirmar necesito:\n• Nombre\n• Fecha y hora de la entrega\n• Ubicación y dirección");
        return res.sendStatus(200);
      }

      if (type==="text" && await tryHandleDynamicFeature(from, text)) {
        return res.sendStatus(200);
      }

      await waSendText(from,"🤖 Soy tu asistente de Tienda RP. Elige 1,2,3 del menú, dime un producto (nombre o código) o escribe una palabra clave (promo, entregas hoy, reclamo, etc).");
    }
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, ()=>console.log("RP-Bot Pack activo ✅"));
