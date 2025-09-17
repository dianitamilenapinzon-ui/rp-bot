# RP Bot Pack (Render + Google Sheets)
1) Sube estos archivos a GitHub (server.js + package.json).
2) En Render → New Web Service:
   - Build: npm install
   - Start: node server.js
3) Variables (usa .env.example).
4) Crea Google Sheet con pestañas Inventario y Funciones (importa los CSV de templates).
5) Comparte la hoja: Cualquiera con enlace → Lector.
6) Cambia TU_ID en las URLs de INVENTORY_CSV_URL y FUNCTIONS_CSV_URL.
7) Conecta Webhook de Meta: https://TU-RENDER.onrender.com/webhook (verify: rpbot2025).