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

		// Log the API key, origin, and referrer for debugging
		const apiKey = cacheUrl.searchParams.get("api_key");
		const origin = request.headers.get("origin");
		const referer = request.headers.get("referer");
		console.log(JSON.stringify({ "api_key": apiKey, "origin": origin, "referer": referer }));

		let response = await cache.match(cacheKey);
		if (response) {
			console.log(`Overall cache hit`);
			return response;
		} else {
			console.log(`Overall cache miss`);
		}

		// Handle an uncached request for the preview page by fetching it from R2.
		// Note that we don't check API key for this request on purpose.
		if (cacheUrl.pathname === "/preview.html") {
			const r2PreviewObj = await env.R2.get("tile.nextzen.org/preview.html");
			if (!r2PreviewObj) {
				console.log(`R2 miss on preview.html`);
				return new Response(`Not found on R2`, {
					status: 404,
					statusText: `Not Found`,
				});
			}

			console.log(`R2 hit on preview.html`);
			const headers = new Headers()
			r2PreviewObj.writeHttpMetadata(headers)
			headers.set('etag', r2PreviewObj.httpEtag)
			const bodyTee = r2PreviewObj.body.tee();
			const resp = new Response(bodyTee[0], {
				headers
			});
			const respForCaches = new Response(bodyTee[1], {
				headers: headers,
			});
			await (cache.put(cacheKey, respForCaches));
			return resp;
		}

		// Check for API key
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

				// Cache the internal tile without the API key for 2 years
				const headersForBareTile = new Headers(headers);
				headersForBareTile.set('cache-control', 'public, max-age=63072000, immutable');
				const respForBareTile = new Response(bodyTeeForCaches[0], {
					headers: headersForBareTile,
				});
				await (cache.put(cachedTileKey, respForBareTile));

				return respForReturn;
			} else {
				console.log(`R2 miss on ${cachedTileURL} from ${r2objectName}`);
			}
		}

		if (r2objectName.startsWith("tile.nextzen.org/tilezen/terrain/")) {
			// As of 2023-04-28: we will make a request to a go-zaloa lambda to do terrain tiles
			const originURL = new URL(request.url);
			originURL.host = "uhcsj5wbqgz6ndoptpomyfoxh40hibis.lambda-url.us-east-1.on.aws";
			originURL.protocol = "https";
			const originRequest = new Request(originURL.toString(), request);
			console.log(`Origin URL: ${originURL}`);

			response = await fetch(originRequest);

			console.log(`Origin response code: ${response.status}`);

			// Copy the response, so we can modify its headers to add CORS
			response = new Response(response.body, response);
			response.headers.set('access-control-allow-origin', '*');

			if (response.status == 200) {
				// Put it in the cache no-api-key cache for 2 years
				const clonedResponse = response.clone();
				const responseForCache = new Response(clonedResponse.body, clonedResponse);
				responseForCache.headers.set('cache-control', 'public, max-age=63072000, immutable');
				ctx.waitUntil(cache.put(cachedTileKey, responseForCache));

				// ... and store it in R2 as well
				const responseBuffer = await response.clone().arrayBuffer();
				// @ts-ignore
				ctx.waitUntil(env.R2.put(r2objectName, responseBuffer, {
					httpMetadata: response.headers,
				}));
			}

			// Always cache for the original request so we get non-200 responses too
			ctx.waitUntil(cache.put(cacheKey, response.clone()));

			return response;
		} else if (r2objectName.startsWith("tile.nextzen.org/tilezen/vector/")) {
			// As of 2023-09-07: We will make a request to tapalcatl lambda to fetch missing vector tiles

			const originURL = new URL(request.url);
			originURL.host = "51prm3zn62.execute-api.us-east-1.amazonaws.com";
			originURL.protocol = "https";
			originURL.pathname = "/dev" + originURL.pathname;
			const originRequest = new Request(originURL.toString(), request);
			console.log(`Origin URL: ${originURL}`);

			response = await fetch(originRequest);

			console.log(`Origin response code: ${response.status}`);

			// Copy the response, so we can modify its headers to add CORS
			response = new Response(response.body, response);
			response.headers.set('access-control-allow-origin', '*');

			if (response.status == 200) {
				// Put it in the cache no-api-key cache for 2 years
				const clonedResponse = response.clone();
				const responseForCache = new Response(clonedResponse.body, clonedResponse);
				responseForCache.headers.set('cache-control', 'public, max-age=63072000, immutable');
				ctx.waitUntil(cache.put(cachedTileKey, responseForCache));

				// ... and store it in R2 as well
				const responseBuffer = await response.clone().arrayBuffer();
				// @ts-ignore
				ctx.waitUntil(env.R2.put(r2objectName, responseBuffer, {
					httpMetadata: response.headers,
				}));
			}

			// Always cache for the original request so we get non-200 responses too
			ctx.waitUntil(cache.put(cacheKey, response.clone()));

			return response;
		}

		// As of 2023-03-01: we return 404 instead of hitting Nextzen AWS account
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
