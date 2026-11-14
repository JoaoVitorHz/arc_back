// Cores que um tipo de compromisso pode ter (o frontend tem o visual de cada uma)
const CORES_TIPO_EVENTO = ['blue', 'purple', 'pink', 'red', 'orange', 'amber', 'green', 'gray'];

// Tipos criados automaticamente para todo escritório novo
const TIPOS_EVENTO_PADRAO = [
  { nome: 'Reunião', cor: 'blue' },
  { nome: 'Visita técnica', cor: 'purple' },
  { nome: 'Visita de obra', cor: 'amber' },
  { nome: 'Entrega', cor: 'green' },
  { nome: 'Outro', cor: 'gray' },
];

module.exports = { CORES_TIPO_EVENTO, TIPOS_EVENTO_PADRAO };
