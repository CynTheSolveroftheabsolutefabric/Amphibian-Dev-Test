interface PackEntry {
	t: string;
	s: number;
	e?: "gzip";
	d: string;
}

interface AssetPack {
	base: string;
	files: Record<string, PackEntry>;
}

export interface SingleFileRuntime {
	frameworkEntry(): string;
	resolveAsset(name: string): string | undefined;
}

const PACK_ID = "amphibian-asset-pack";
const FAKE_BASE = "https://amphibian-singlefile.invalid/";
let active: SingleFileRuntime | null | undefined;

class Runtime {
	private readonly entries: Record<string, PackEntry>;
	private readonly names: string[];
	private readonly byBasename = new Map<string, string>();
	private readonly bytesCache = new Map<string, Promise<Uint8Array>>();
	private readonly urlCache = new Map<string, string>();
	private readonly pendingUrls = new Map<string, Promise<string>>();
	private readonly base: string;

	constructor(pack: AssetPack) {
		this.base = pack.base.endsWith("/") ? pack.base : pack.base + "/";
		this.entries = pack.files;
		this.names = Object.keys(pack.files);
		for (const name of this.names) {
			const base = name.slice(name.lastIndexOf("/") + 1);
			const current = this.byBasename.get(base);
			if (current === undefined || (name.startsWith("_framework/") && !current.startsWith("_framework/"))) {
				this.byBasename.set(base, name);
			}
		}
	}

	has(name: string): boolean {
		return this.resolveName(name) !== null;
	}

	asset(name: string): string {
		const resolved = this.resolveName(name);
		return resolved === null ? this.base + name : this.urlCache.get(resolved) ?? this.base + resolved;
	}

	resolveName(input: RequestInfo | URL): string | null {
		let raw: string;
		if (typeof input === "string") raw = input;
		else if (input instanceof URL) raw = input.href;
		else if (typeof Request !== "undefined" && input instanceof Request) raw = input.url;
		else raw = String(input);
		if (raw.startsWith("data:") || raw.startsWith("blob:")) return null;

		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(raw, globalThis.location.href).pathname);
		} catch {
			return null;
		}
		let clean = pathname.replace(/^\/+/, "");
		try {
			const pageDir = new URL(".", globalThis.location.href).pathname.replace(/^\/+/, "");
			if (pageDir !== "" && clean.startsWith(pageDir)) clean = clean.slice(pageDir.length);
		} catch {}
		if (this.entries[clean] !== undefined) return clean;

		let best: string | null = null;
		for (const name of this.names) {
			if ((clean === name || clean.endsWith("/" + name)) && (best === null || name.length > best.length)) best = name;
		}
		if (best !== null) return best;

		return this.byBasename.get(clean) ?? this.byBasename.get(clean.slice(clean.lastIndexOf("/") + 1)) ?? null;
	}

	private async bytes(name: string): Promise<Uint8Array> {
		let promise = this.bytesCache.get(name);
		if (promise === undefined) {
			promise = (async () => {
				const entry = this.entries[name];
				if (entry === undefined) throw new Error(`single-file asset missing: ${name}`);
				const binary = atob(entry.d);
				let bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
				if (entry.e === "gzip") {
					if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decompress the single-file asset pack");
					const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
					bytes = new Uint8Array(await new Response(stream).arrayBuffer());
				}
				if (bytes.byteLength !== entry.s) throw new Error(`single-file asset size mismatch: ${name}`);
				return bytes;
			})();
			this.bytesCache.set(name, promise);
		}
		return await promise;
	}

	private async prepare(name: string): Promise<string> {
		const cached = this.urlCache.get(name);
		if (cached !== undefined) return cached;
		let pending = this.pendingUrls.get(name);
		if (pending === undefined) {
			pending = this.build(name).then((url) => {
				this.urlCache.set(name, url);
				this.pendingUrls.delete(name);
				return url;
			});
			this.pendingUrls.set(name, pending);
		}
		return await pending;
	}

	private async build(name: string): Promise<string> {
		const base = name.slice(name.lastIndexOf("/") + 1);
		const text = /\.(?:js|mjs)$/.test(name);
		if (base === "dotnet.native.worker.mjs") {
			// The worker maps framework imports and DLL/WASM fetches through the
			// prelude, so every embedded asset it could ask for must have a blob
			// URL before the prelude is generated. Skip only the worker itself.
			for (const asset of this.names) {
				if (asset === name) continue;
				if (/\.(?:dll|wasm|js|mjs)$/.test(asset)) await this.prepare(asset);
			}
		}
		let bytes = await this.bytes(name);
		if (text) {
			let source = new TextDecoder().decode(bytes);
			source = this.patch(name, base, source);
			bytes = new TextEncoder().encode(source);
		}
		const type = this.entries[name]?.t ?? "application/octet-stream";
		return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
	}

	private patch(name: string, base: string, source: string): string {
		source = source.replace(
			/^import \{ installWorkerResourceLoader \} from "\.\/split-resources\.js";\s*installWorkerResourceLoader\(\);\s*/,
			"",
		);
		if (/^dotnet\.native.*\.js$/.test(base) && !base.includes(".worker.")) {
			source = source.replace(
				/new Worker\(\s*new URL\(\s*["']dotnet\.native\.worker\.mjs["']\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type\s*:\s*["']module["']\s*\}\s*\)/g,
				'new Worker(globalThis.__sfAssetUrl("dotnet.native.worker.mjs"),{type:"module"})',
			);
		}
		if (base === "dotnet.native.worker.mjs") {
			source = source.replace(
				/\bimport\(\s*["']\.\/dotnet\.native\.js["']\s*\)/g,
				'import(globalThis.__sfAssetUrl("dotnet.native.js"))',
			);
		}
		source = source.replace(/import\.meta\.url/g, JSON.stringify(new URL(name, this.base).href));
		source = source.replace(/import\(\s*\/\*! webpackIgnore: true \*\/\s*/g, "globalThis.__sfImport(");
		source = source.replace(
			/\bimport\(\s*(["'])\.\/([^"']+)\1\s*\)/g,
			(_match, _quote: string, relative: string) => `globalThis.__sfImport(${JSON.stringify(relative)})`,
		);
		if (base === "dotnet.native.worker.mjs") {
			return this.workerPrelude() + source;
		}
		return source;
	}

	private workerPrelude(): string {
		const urls: Record<string, string> = {};
		for (const name of this.names) {
			if (name.endsWith("dotnet.native.worker.mjs")) continue;
			if (/\.(?:dll|wasm|js|mjs)$/.test(name)) urls[name] = this.urlCache.get(name) ?? "";
		}
		const sizes: Record<string, number> = {};
		for (const name of this.names) {
			if (/\.(?:dll|wasm)$/.test(name)) sizes[name] = this.entries[name]!.s;
		}
		return `(() => {
const urls = ${JSON.stringify(urls)};
const sizes = ${JSON.stringify(sizes)};
const names = Object.keys(urls);
const base = /^https?:/.test(globalThis.location?.href ?? "") ? globalThis.location.href : "https://amphibian-singlefile.invalid/";
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.__sfAssetUrl = (name) => {
	const clean = String(name).replace(/^.*[\\\\/]/, "");
	for (const key of names) if (key === name || key.endsWith("/" + clean)) return urls[key];
	return name;
};
globalThis.fetch = (input, init = {}) => {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const pathname = new URL(raw, base).pathname;
	const clean = pathname.replace(/^\\/+/, "");
	let key = null;
	for (const name of names) if (name === clean || clean.endsWith("/" + name)) { key = name; break; }
	if (key === null) {
		const base = clean.slice(clean.lastIndexOf("/") + 1);
		for (const name of names) if (name.slice(name.lastIndexOf("/") + 1) === base) { key = name; break; }
	}
	if (key === null || !/\\.(?:dll|wasm)$/.test(key)) return nativeFetch(input, init);
	const method = (init.method || "GET").toUpperCase();
	const type = key.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
	if (method === "HEAD") return Promise.resolve(new Response(null, { headers: { "Content-Type": type, "Content-Length": String(sizes[key]) } }));
	return nativeFetch(urls[key], init);
};
})();
`;
	}

	private async prepareAll(): Promise<void> {
		for (const name of this.names) {
			if (/\.(?:js|mjs)$/.test(name)) await this.prepare(name);
		}
	}

	async install(): Promise<void> {
		const nativeFetch = globalThis.fetch.bind(globalThis);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const name = this.resolveName(input);
			return name === null ? nativeFetch(input, init) : this.serve(name, init ?? {});
		}) as typeof fetch;
		(globalThis as any).__sfFetch = (uri: string | URL | Request, init: RequestInit = {}) => {
			const name = this.resolveName(uri);
			return name === null ? null : this.serve(name, init);
		};
		(globalThis as any).__sfImport = (specifier: string) => {
			const name = this.resolveName(specifier);
			const target = name === null ? specifier : this.asset(name);
			return import(/* @vite-ignore */ target);
		};
		(globalThis as any).__sfAssetUrl = (name: string) => this.asset(name);
		await this.prepareAll();
	}

	private async serve(name: string, init: RequestInit): Promise<Response> {
		const entry = this.entries[name]!;
		const headers = new Headers();
		headers.set("Content-Type", entry.t);
		headers.set("Accept-Ranges", "bytes");
		const method = (init.method ?? "GET").toUpperCase();
		const range = new Headers(init.headers).get("range");
		if (range !== null) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match !== null) {
				const data = await this.bytes(name);
				let start: number;
				let end: number;
				if (match[1] === "" && match[2] !== "") {
					start = Math.max(0, data.byteLength - Number(match[2]));
					end = data.byteLength - 1;
				} else {
					start = Number(match[1]);
					end = match[2] === "" ? data.byteLength - 1 : Math.min(Number(match[2]), data.byteLength - 1);
				}
				if (start >= data.byteLength || end < start) {
					return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${data.byteLength}` } });
				}
				headers.set("Content-Length", String(end - start + 1));
				headers.set("Content-Range", `bytes ${start}-${end}/${data.byteLength}`);
				return new Response(method === "HEAD" ? null : (data.slice(start, end + 1).buffer as ArrayBuffer), {
					status: 206,
					statusText: "Partial Content",
					headers,
				});
			}
		}
		headers.set("Content-Length", String(entry.s));
		if (method === "HEAD") return new Response(null, { headers });
		const data = await this.bytes(name);
		return new Response(data.slice().buffer as ArrayBuffer, { headers });
	}
}

export async function installSingleFile(): Promise<SingleFileRuntime | null> {
	if (active !== undefined) return active;
	if (typeof document === "undefined") {
		active = null;
		return null;
	}
	const element = document.getElementById(PACK_ID);
	const text = element?.textContent;
	if (text === null || text === undefined || text === "") {
		active = null;
		return null;
	}
	let pack: AssetPack;
	try {
		pack = JSON.parse(text) as AssetPack;
	} catch (error) {
		console.warn("[singlefile] asset pack is not valid JSON", error);
		active = null;
		return null;
	}
	const runtime = new Runtime(pack);
	await runtime.install();
	active = {
		frameworkEntry: () => runtime.asset("dotnet.js"),
		resolveAsset: (name: string) => (runtime.has(name) ? runtime.asset(name) : undefined),
	};
	console.info(`[singlefile] loaded ${Object.keys(pack.files).length} embedded assets from ${FAKE_BASE}`);
	return active;
}
