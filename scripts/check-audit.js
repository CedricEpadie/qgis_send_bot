// Contrôle des vulnérabilités des dépendances : échoue si une NOUVELLE vulnérabilité apparaît (ou si l'une est critique).
// Les paquets ci-dessous sont connus et acceptés : ils viennent de whatsapp-web.js / puppeteer, sans correctif
// publié, et leur code vulnérable n'est pas exécuté ici (Chromium système, pas de proxy, pas de sauvegarde RemoteAuth).
const { execSync } = require('child_process');
const ACCEPTED = {
  'extract-zip': 'extraction de l’archive Chromium au téléchargement (désactivé : PUPPETEER_SKIP_DOWNLOAD)',
  '@puppeteer/browsers': 'téléchargement de Chromium (désactivé)',
  puppeteer: 'dépend de @puppeteer/browsers', 'puppeteer-core': 'dépend de @puppeteer/browsers', 'whatsapp-web.js': 'dépend de puppeteer',
  zod: 'validation des messages WebDriver BiDi (non utilisé : protocole CDP)', 'chromium-bidi': 'WebDriver BiDi (non utilisé)',
  archiver: 'sauvegarde RemoteAuth (non utilisé : LocalAuth)', 'archiver-utils': 'idem', 'zip-stream': 'idem', glob: 'idem', minimatch: 'idem',
};
let report;
try { report = JSON.parse(execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
catch (e) { report = JSON.parse(e.stdout); }          // npm audit renvoie un code d'erreur dès qu'une vulnérabilité existe
const found = Object.entries(report.vulnerabilities || {});
const fresh = found.filter(([name, v]) => !ACCEPTED[name] || v.severity === 'critical');
console.log(`${found.length} vulnérabilité(s) connue(s), dont ${found.length - fresh.length} acceptée(s).`);
if (fresh.length) { console.error('NOUVELLES vulnérabilités :\n' + fresh.map(([n, v]) => ` - ${n} (${v.severity})`).join('\n')); process.exit(1); }
console.log('Aucune nouvelle vulnérabilité.');
