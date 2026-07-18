# Helios Instant Conferences Backend

Servidor liviano de señalización WebSocket para el MVP de conferencias de Caribbean One.

## Alcance actual

- Salas efímeras en memoria.
- Máximo estricto de dos participantes por sala.
- Retransmisión de SDP, ICE y estados de cámara/micrófono/pantalla.
- Credenciales TURN temporales compatibles con `use-auth-secret` de coturn.
- Validación de origen, tamaño máximo de mensajes, rate limiting y heartbeat.
- Sin grabación, almacenamiento de audio/video ni dependencia de APIs pagadas.

## Desarrollo local

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

El servidor escucha por defecto en `http://localhost:8787`. El portal Vite usa ese destino automáticamente durante desarrollo.

## Variables de producción

Copiar `.env.example` a `/etc/helios-conferences.env` y definir como mínimo:

- `NODE_ENV=production`
- `ALLOWED_ORIGINS=https://caribbean-one.site,https://www.caribbean-one.site`
- `STUN_URLS=stun:turn.caribbean-one.site:3478`
- `TURN_URLS=turn:turn.caribbean-one.site:3478?transport=udp,turn:turn.caribbean-one.site:3478?transport=tcp`
- `TURN_SHARED_SECRET`: secreto aleatorio largo, igual al configurado en coturn.

## Puertos EC2

- `80/TCP` y `443/TCP`: Nginx/certificados.
- `3478/TCP` y `3478/UDP`: STUN/TURN.
- `5349/TCP` y `5349/UDP`: TURN TLS/DTLS cuando se habilite.
- `49160-49200/UDP`: puertos relay del MVP.

El puerto `8787` debe permanecer privado y escucharse únicamente detrás de Nginx.

## Despliegue

1. Compilar con `npm ci && npm run build`.
2. Instalar el proyecto en `/opt/helios-instant-conferences-backend`.
3. Instalar el servicio de `deploy/helios-conferences.service`.
4. Instalar `deploy/nginx.conf.example` como virtual host de `turn.caribbean-one.site` y emitir su certificado con Certbot.
5. Instalar coturn y adaptar `deploy/turnserver.conf.example`.
6. Crear el DNS `turn.caribbean-one.site` hacia la IP pública de la EC2.
7. Verificar `https://turn.caribbean-one.site/health`.

La señalización utiliza muy pocos recursos. El consumo relevante ocurre únicamente cuando TURN debe retransmitir audio/video porque los dos navegadores no consiguen una ruta P2P directa.
