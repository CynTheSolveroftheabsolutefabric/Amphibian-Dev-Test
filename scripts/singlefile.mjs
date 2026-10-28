#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dist = path.resolve(process.argv[2] ?? "frontend/dist-single");
const htmlPath = path.join(dist, "index.html");
if (!fs.existsSync(htmlPath)) {
	throw new Error(`missing ${htmlPath} (run vite build --outDir dist-single first)`);
}

const MIME = new Map(Object.entries({
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".html": "text/html; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".jar": "application/java-archive",
	".zip": "application/zip",
	".dat": "application/octet-stream",
	".dll": "application/octet-stream",
	".so": "application/octet-stream",
	".a": "application/octet-stream",
	".bin": "application/octet-stream",
}));

function mime(name) {
	return MIME.get(path.extname(name).toLowerCase()) ?? "application/octet-stream";
}

function walk(dir, base = dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(file, base, out);
		else if (entry.isFile()) out.push(path.relative(base, file).split(path.sep).join("/"));
	}
	return out;
}

function localPath(url) {
	const clean = url.split(/[?#]/, 1)[0];
	if (/^[a-z]+:/i.test(clean) || clean.startsWith("//")) return null;
	return path.join(dist, decodeURIComponent(clean.replace(/^\.?\//, "")));
}

function dataUrl(name, bytes) {
	return `data:${mime(name)};base64,${bytes.toString("base64")}`;
}

function escapeInlineScript(value) {
	return value.replace(/<\/script/gi, "<\\/script");
}

const files = new Map();
const manifestPath = path.join(dist, "_framework", "split-resources.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
const splitNames = Object.keys(manifest);

for (const [name, entry] of Object.entries(manifest)) {
	const chunks = [];
	for (let i = 0; i < Number(entry.parts); i += 1) {
		chunks.push(fs.readFileSync(path.join(dist, "_framework", name + i)));
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.length !== Number(entry.size)) {
		throw new Error(`reassembled ${name}: expected ${entry.size} bytes, got ${bytes.length}`);
	}
	files.set(`_framework/${name}`, bytes);
}

function isSplitPart(rel) {
	if (!rel.startsWith("_framework/")) return false;
	const base = rel.slice("_framework/".length);
	return splitNames.some((name) => base.startsWith(name) && /^\d+$/.test(base.slice(name.length)));
}

const grassPath = path.join(dist, "grass-block.svg");
const logoPath = path.join(dist, "logo.png");
const grass = fs.existsSync(grassPath) ? dataUrl("grass-block.svg", fs.readFileSync(grassPath)) : null;
const logo = fs.existsSync(logoPath) ? dataUrl("logo.png", fs.readFileSync(logoPath)) : null;

const entryScripts = new Set();
const entryStyles = new Set();
let html = fs.readFileSync(htmlPath, "utf8");

html = html.replace(/<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/gi, (match, before, src, after) => {
	if (/coi-serviceworker\.js(?:\?|$)/.test(src)) return "";
	if (!/\btype="module"/i.test(before + after)) return match;
	const file = localPath(src);
	if (file === null || !fs.existsSync(file)) return match;
	const rel = path.relative(dist, file).split(path.sep).join("/");
	entryScripts.add(rel);
	let source = fs.readFileSync(file, "utf8");
	if (logo !== null) source = source.replaceAll("./logo.png", logo).replaceAll("/logo.png", logo);
	return `<script type="module">\n${escapeInlineScript(source)}\n</script>`;
});

html = html.replace(/<link\b([^>]*)>/gi, (match, attrs) => {
	const rel = /\brel="([^"]*)"/i.exec(attrs)?.[1]?.toLowerCase();
	if (rel === "modulepreload") return "";
	if (rel !== "stylesheet") return match;
	const href = /\bhref="([^"]+)"/i.exec(attrs)?.[1];
	if (!href) return match;
	const file = localPath(href);
	if (file === null || !fs.existsSync(file)) return match;
	const relPath = path.relative(dist, file).split(path.sep).join("/");
	entryStyles.add(relPath);
	let css = fs.readFileSync(file, "utf8");
	css = css.replace(/url\((["']?)([^)"']+)\1\)/gi, (m, _quote, url) => {
		if (/^(data:|https?:|blob:|\/\/)/i.test(url)) return m;
		const target = path.resolve(path.dirname(file), url.split(/[?#]/, 1)[0]);
		if (!target.startsWith(dist + path.sep) || !fs.existsSync(target)) return m;
		return `url("${dataUrl(target, fs.readFileSync(target))}")`;
	});
	return `<style>\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`;
});

if (entryScripts.size === 0) throw new Error("no module entry script found in index.html; was inlineDynamicImports enabled?");
if (grass !== null) html = html.replaceAll("./grass-block.svg", grass);

const skip = new Set([
	"index.html",
	"coi-serviceworker.js",
	"_headers",
	".nojekyll",
	"split-resources.json",
	"split-resources.js",
	"logo.png",
	"grass-block.svg",
	...entryScripts,
	...entryStyles,
]);

for (const rel of walk(dist)) {
	if (skip.has(rel) || isSplitPart(rel) || rel.endsWith(".map")) continue;
	files.set(rel, fs.readFileSync(path.join(dist, rel)));
}

if (!files.has("_framework/dotnet.js")) {
	throw new Error("missing _framework/dotnet.js; run the .NET build (make build) before packing the single HTML");
}

const pack = { base: "https://amphibian-singlefile.invalid/", files: {} };
for (const [name, bytes] of files) {
	let data = bytes;
	let encoding;
	if (bytes.length >= 512) {
		const compressed = zlib.gzipSync(bytes, { level: 6 });
		if (compressed.length < bytes.length) {
			data = compressed;
			encoding = "gzip";
		}
	}
	pack.files[name] = {
		t: mime(name),
		s: bytes.length,
		...(encoding ? { e: encoding } : {}),
		d: data.toString("base64"),
	};
}

const packJson = JSON.stringify(pack).replace(/</g, "\\u003c");
const packTag = `<script id="amphibian-asset-pack" type="application/json">${packJson}</script>`;
if (!html.includes('<script type="module">')) throw new Error("no inline module script to attach the asset pack to");
html = html.replace(/(<script type="module">)/, `${packTag}\n$1`);

fs.writeFileSync(htmlPath, html);
const bytes = Buffer.byteLength(html);
const mib = (bytes / 1048576).toFixed(1);
console.log(`[singlefile] ${files.size} assets, ${splitNames.length} split resources -> ${htmlPath} (${mib} MiB)`);
if (bytes > 25 * 1024 * 1024) {
	console.warn("[singlefile] warning: over Cloudflare Pages' 25 MiB per-file limit");
}
if (bytes > 100 * 1024 * 1024) {
	console.warn("[singlefile] warning: over GitHub Pages' 100 MB per-file limit");
}
