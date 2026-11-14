const nodemailer = require('nodemailer');

// Envio de e-mails. Configure o SMTP no .env (Gmail com senha de app, Brevo, Resend...).
// Sem SMTP_HOST (ex.: em desenvolvimento), o e-mail é mostrado no terminal em vez de enviado.

let transporte;

function smtpConfigurado() {
  return Boolean(process.env.SMTP_HOST);
}

function obterTransporte() {
  if (!transporte) {
    const porta = Number(process.env.SMTP_PORT || 587);
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: porta,
      secure: porta === 465, // 465 = SSL direto; 587 = STARTTLS
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporte;
}

async function enviarEmail({ para, assunto, texto, html }) {
  if (!smtpConfigurado()) {
    console.log(
      ['', '──── E-mail (SMTP não configurado: só exibido aqui) ────', `Para: ${para}`, `Assunto: ${assunto}`, '', texto, '────────────────────────────────────────────────────────', ''].join('\n')
    );
    return;
  }

  await obterTransporte().sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: para,
    subject: assunto,
    text: texto,
    html,
  });
}

// Escapa texto vindo do usuário (nomes, nome do escritório) antes de colocar no HTML do e-mail
function escaparHtml(texto) {
  return String(texto ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = { enviarEmail, escaparHtml, smtpConfigurado };
