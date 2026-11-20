// Marca (ou desmarca) uma conta como dona da plataforma, com acesso ao painel admin (/admin).
// Uso: npm run admin:dono -- email@exemplo.com          (marca)
//      npm run admin:dono -- email@exemplo.com --tirar  (desmarca)
require('dotenv').config({ quiet: true });
const prisma = require('../src/lib/prisma');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const tirar = process.argv.includes('--tirar');
  if (!email) {
    console.log('Informe o e-mail: npm run admin:dono -- email@exemplo.com');
    process.exit(1);
  }
  const usuario = await prisma.usuario.findUnique({ where: { email }, select: { id: true, nome: true } });
  if (!usuario) {
    console.log(`Não existe conta com o e-mail ${email}`);
    process.exit(1);
  }
  await prisma.usuario.update({ where: { id: usuario.id }, data: { donoPlataforma: !tirar } });
  console.log(tirar ? `${usuario.nome} não é mais dono da plataforma.` : `${usuario.nome} agora acessa o painel admin (/admin).`);
  await prisma.$disconnect();
})();
