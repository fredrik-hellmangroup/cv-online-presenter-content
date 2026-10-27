import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const root = process.cwd();
const pagesRoot = path.join(root, 'content', 'pages');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'content', 'site.json'), 'utf8'));
const locales = new Set(settings.supportedLocales ?? []);
const files = fs.readdirSync(pagesRoot, { recursive: true }).filter(file => file.endsWith('.md'));
const documents = [];
const failures = [];
const fieldsByType = {
  page: ['title', 'description'],
  profile: ['displayName', 'headline', 'summary'],
  experience: ['role', 'organization', 'dates', 'highlights'],
  project: ['title', 'summary', 'technologies', 'links'],
  service: ['label', 'description'],
  skill: ['label', 'description']
};

for (const file of files) {
  const sourcePath = path.join(pagesRoot, file);
  const parsed = matter(fs.readFileSync(sourcePath, 'utf8'));
  const slug = path.relative(pagesRoot, sourcePath).replaceAll(path.sep, '/').replace(/\.md$/, '');
  const data = parsed.data;
  const fail = message => failures.push(`${file}: ${message}`);
  documents.push({ file, slug, data, body: parsed.content });
  for (const field of ['title', 'description', 'locale', 'status', 'type']) {
    if (typeof data[field] !== 'string' || data[field].trim() === '') fail(`required field '${field}' is missing`);
  }
  if (!['draft', 'published'].includes(data.status)) fail("status must be 'draft' or 'published'");
  if (!locales.has(data.locale)) fail(`unsupported locale '${data.locale}'`);
  if (!fieldsByType[data.type]) fail(`unknown content type '${data.type}'`);
  else for (const field of fieldsByType[data.type]) {
    if (data[field] === undefined || data[field] === null || String(data[field]).trim() === '') fail(`content type '${data.type}' requires '${field}'`);
  }
  if (data.status === 'published' && parsed.content.trim() === '') fail('published content body is empty');
  for (const match of parsed.content.matchAll(/(?<!!)\[[^\]]*\]\((?<url>[^)\s]+)\)/g)) {
    const target = match.groups.url;
    const scheme = target.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
    if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) fail(`URL scheme '${scheme}' is not allowed`);
  }
}

const published = documents.filter(document => document.data.status === 'published');
for (const field of ['slug', 'title', 'description']) {
  const values = new Map();
  for (const document of published) {
    const value = field === 'slug' ? document.slug : document.data[field];
    const key = `${document.data.locale}:${String(value).toLowerCase()}`;
    if (values.has(key)) failures.push(`${document.file}: ${field} '${value}' is not unique in locale '${document.data.locale}'`);
    values.set(key, document.file);
  }
}
const publishedSlugs = new Set(published.map(document => document.slug.toLowerCase()));
for (const document of published) for (const match of document.body.matchAll(/(?<!!)\[[^\]]*\]\((?<url>[^)\s]+)\)/g)) {
  const target = match.groups.url;
  if (target.startsWith('/') && !target.startsWith('//')) {
    const slug = target.split(/[?#]/, 1)[0].replace(/^\//, '').toLowerCase();
    if (slug && !publishedSlugs.has(slug)) failures.push(`${document.file}: internal link '${target}' has no published target`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Validated ${documents.length} Markdown document(s); ${published.length} published.`);
