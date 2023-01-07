export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	R2: R2Bucket,
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		const cacheUrl = new URL(request.url);
		const cacheKey = new Request(cacheUrl.toString(), request);
		const cache = caches.default;

		// Check whether the value is already available in the cache
		// if not, you will need to fetch it from origin, and store it in the cache
		// for future access
		let response = await cache.match(cacheKey);
		if (response) {
			console.log(`Overall cache hit`);
			return response;
		} else {
			console.log(`Overall cache miss`);
		}

		// Check for API key
		const params = cacheUrl.searchParams;

		const apiKey = params.get("api_key");
		if (!apiKey) {
			let resp = new Response(`An API key is required`, {
				status: 400,
				statusText: `Missing API Key`,
			});
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		// Ask developers.nextzen.org if the API key is valid
		const developersURL = new URL("https://developers.nextzen.org/verify");
		developersURL.searchParams.append("api_key", apiKey);
		const requestOrigin = request.headers.get("origin");
		if (requestOrigin) {
			developersURL.searchParams.append("origin", requestOrigin);
		}
		console.log(`Developers check is ${developersURL}`);
		const devRequest = new Request(developersURL);
		let devResponse = await cache.match(devRequest);
		if (!devResponse) {
			console.log(`Cache miss for dev`);
			devResponse = await fetch(devRequest);
			// Make headers mutable by copying the response
			devResponse = new Response(devResponse.body, devResponse);
			devResponse.headers.append('Cache-Control', 's-maxage=300');
			ctx.waitUntil(cache.put(devRequest, devResponse.clone()));
		} else {
			console.log(`Cache hit for dev`);
		}

		const devData = await devResponse.json();

		console.log(`Dev response is ${devResponse.status}, ${JSON.stringify(devData)}`);
		if (devData.result != "success") {
			let resp = new Response(devData.message, {
				status: 400,
				statusText: `Invalid API Key`,
			});
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		// Check cache for tile (without api_key to increase hit rate)
		const cachedTileURL = new URL(request.url);
		cachedTileURL.host = "internal-tile.nextzen.org";
		cachedTileURL.search = "";
		const r2objectName = `tile.nextzen.org${cachedTileURL.pathname}`;
		console.log(`R2 object name: ${r2objectName}`);
		const cachedTileKey = new Request(cachedTileURL);
		console.log(`Key used for internal tile match: ${cachedTileURL}`);
		const cachedTile = await cache.match(cachedTileKey);
		if (cachedTile) {
			console.log(`Cache hit on ${cachedTileURL}`);
			return cachedTile;
		} else {
			console.log(`Cache miss on ${cachedTileURL}`);

			// Check R2 before fetching from origin
			let r2TileObj = await env.R2.get(r2objectName);

			if (r2TileObj) {
				console.log(`R2 hit on ${cachedTileURL} from ${r2objectName}`);
				const headers = new Headers()
				r2TileObj.writeHttpMetadata(headers)
				headers.set('etag', r2TileObj.httpEtag)
				const resp = new Response(r2TileObj.body, {
					headers
				});
				ctx.waitUntil(cache.put(cachedTileKey, resp.clone()));
				return resp;
			} else {
				console.log(`R2 miss on ${cachedTileURL} from ${r2objectName}`);
			}
		}

		// Fetch from the origin
		const originURL = new URL(request.url);
		originURL.host = "tile.nextzen.org";
		const originRequest = new Request(originURL.toString(), request);
		console.log(`Origin URL: ${originURL}`);

		response = await fetch(originRequest);

		console.log(`Origin response code: ${response.status}`);

		// Put it in the cache no-api-key cache
		ctx.waitUntil(cache.put(cachedTileKey, response.clone()));

		const tees = response.body.tee();
		// ... and store it in R2 as well
		await env.R2.put(r2objectName, tees[0], {
			httpMetadata: response.headers,
		});
		return response;
	},
};
