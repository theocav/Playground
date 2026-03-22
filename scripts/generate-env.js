const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const outputPath = path.join(rootDir, 'assets', 'js', 'env.js');

const defaultEnv = {
  POLYPLACES_API_BASE_URL: '',
  POLYPLACES_SITE_URL: 'polyplaces.co.uk',
  POLYPLACES_NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
  POLYPLACES_SEARCH_COUNTRY_CODES: 'gb',
  POLYPLACES_SEARCH_VIEWBOX: '-8.7,60.9,1.9,49.8',
};

function parseEnvFile(contents) {
  const parsed = {};

  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  });

  return parsed;
}

let fileEnv = {};
if (fs.existsSync(envPath)) {
  fileEnv = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
}

const env = { ...defaultEnv, ...fileEnv };

const output = `window.__POLYPLACES_ENV__ = ${JSON.stringify(env, null, 2)};\n`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf8');

console.log(`Generated ${path.relative(rootDir, outputPath)} from .env`);
