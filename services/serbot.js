const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const baileys = require('baileys');
const pino = require('pino');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = baileys;

const manejarComando = require("../index.js");

function removeAccentsAndSpecialCharacters(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "");
}

module.exports = async (conn, from, args) => {
  try {
    const usarCode = args && ['code', 'sercode'].includes(args[0]);
    const sessionDir = path.join(__dirname, "../subbots");
    const sessionPath = path.join(sessionDir, from.split("@")[0]);

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    await conn.sendMessage(from, { react: { text: '⌛', key: { remoteJid: from } } });

    let subbotIniciado = false;

    const startSubbot = async () => {
      if (subbotIniciado) return;
      subbotIniciado = true;

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();
      const logger = pino({ level: "silent" });

      const sock = makeWASocket({
        version,
        logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys)
        },
        printQRInTerminal: false,
        browser: ['SoyMaycol', 'Chrome', '1.0']
      });

      // Ahora los mensajes pasan a index.js
      sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m || !m.message || m.key.fromMe) return;

        const tipo = Object.keys(m.message)[0];
        let texto = '';

        if (tipo === 'conversation') texto = m.message.conversation;
        else if (tipo === 'extendedTextMessage') texto = m.message.extendedTextMessage.text;
        else if (tipo === 'imageMessage' && m.message.imageMessage.caption) texto = m.message.imageMessage.caption;
        else if (tipo === 'videoMessage' && m.message.videoMessage.caption) texto = m.message.videoMessage.caption;

        texto = texto.trim();
        const jid = m.key.remoteJid;

        // Prefijo
        const prefix = ['.', '/', '#', '!', '?'].find(p => texto.startsWith(p));
        if (!prefix) return;

        const args = texto.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const cleanCommand = removeAccentsAndSpecialCharacters(command);

        try {
          // Asegurarse de que la función manejarComando está recibiendo correctamente el socket y el jid.
          await manejarComando(sock, jid, cleanCommand, args);
        } catch (err) {
          console.error("Error al ejecutar comando:", err);
          await sock.sendMessage(jid, { text: "❌ Ocurrió un error al ejecutar el comando." });
        }
      });

      sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr && !usarCode) {
          const qrImage = await QRCode.toBuffer(qr);
          await conn.sendMessage(from, {
            image: qrImage,
            caption: "📲 Escanea el QR desde *WhatsApp > Vincular dispositivo*"
          });
        }

        if (connection === "open") {
          await conn.sendMessage(from, {
            text: `✅ *Subbot conectado con éxito.*\n\nUsa *#menu* para ver los comandos disponibles.\n\nCanal: https://whatsapp.com/channel/0029VayXJte65yD6LQGiRB0R`
          });
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const code = DisconnectReason[statusCode] || lastDisconnect?.reason || "Desconocido";

          if (code !== 'restartRequired') {
            await conn.sendMessage(from, {
              text: `❌ *Subbot desconectado.* Motivo: ${code}.`
            });
          }

          const debeReconectar = ['restartRequired', 'connectionClosed', 'timedOut'].includes(code);

          if (usarCode) {
            subbotIniciado = false;
            return;
          }

          if (debeReconectar) {
            subbotIniciado = false;
            return startSubbot();
          }

          if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      });

      sock.ev.on("creds.update", saveCreds);

      if (usarCode) {
        try {
          const code = await sock.requestPairingCode(from.split("@")[0]);
          await conn.sendMessage(from, {
            text: `🔐 *Código generado:*\n\n${code}`
          });
        } catch (e) {
          await conn.sendMessage(from, {
            text: `❌ Error al generar código: ${e.message}`
          });
          subbotIniciado = false;
        }
      }
    };

    await startSubbot();

  } catch (e) {
    console.error("Error al conectar subbot:", e);
    await conn.sendMessage(from, {
      text: `❌ Error al conectar subbot: ${e.message || e}`
    });
  }
};
