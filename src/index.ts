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
				headers: {
					"access-control-allow-origin": "*",
				},
			});
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		// Ask developers.nextzen.org if the API key is valid
		const developersURL = new URL("https://0b59atforl.execute-api.us-east-1.amazonaws.com/prod/verify");
		developersURL.searchParams.append("api_key", apiKey);
		const requestOrigin = request.headers.get("origin");
		if (requestOrigin) {
			developersURL.searchParams.append("origin", requestOrigin);
		}
		const devRequest = new Request(developersURL.toString());
		console.log(`dev method: ${devRequest.method}, url: ${devRequest.url}, headers: ${JSON.stringify(Object.fromEntries([...devRequest.headers]))}`);
		const devResponse = await fetch(devRequest, {
			redirect: "manual",
			cf: {
				cacheTtl: 900,
				cacheEverything: true,
			}
		});

		if (devResponse.status == 301 || devResponse.status == 302) {
			console.log(`Dev response is url ${devResponse.url}, redirect to ${devResponse.headers.get("location")}, content ${await devResponse.text()}`);
		} else {
			const devData = await devResponse.json();

			console.log(`Dev response is ${devResponse.status}, cache: ${devResponse.headers.get("cf-cache-status")}, ${JSON.stringify(devData)}`);
			if (devData.result != "success") {
				let resp = new Response(devData.message, {
					status: 400,
					statusText: `Invalid API Key`,
					headers: {
						"access-control-allow-origin": "*",
					},
				});
				ctx.waitUntil(cache.put(cacheKey, resp.clone()));
				return resp;
			}
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

			// Put it in the cache for the original request
			ctx.waitUntil(cache.put(cacheKey, cachedTile.clone()));

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
				headers.set('access-control-allow-origin', '*');
				const bodyTee = r2TileObj.body.tee();
				const respForReturn = new Response(bodyTee[0], {
					headers
				});

				const bodyTeeForCaches = bodyTee[1].tee();
				const respForOverallTile = new Response(bodyTeeForCaches[1], {
					headers: headers,
				});
				await (cache.put(cacheKey, respForOverallTile));

				const respForBareTile = new Response(bodyTeeForCaches[0], {
					headers: headers,
				});
				await (cache.put(cachedTileKey, respForBareTile));

				return respForReturn;
			} else {
				console.log(`R2 miss on ${cachedTileURL} from ${r2objectName}`);
			}
		}

		// As of March 1, we return 404 instead of hitting Nextzen AWS account
		console.log(`Returning 404 instead of making request to Nextzen`);
		return new Response(`Nextzen is experimenting with a lower cost cached mode. Please contact hello@nextzen.org with questions.`, {
			status: 404,
			statusText: `Missing Tile`,
			headers: {
				"access-control-allow-origin": "*",
			},
		});
	},
};
