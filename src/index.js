import * as photon from '@silvia-odwyer/photon';
import PHOTON_WASM from '../node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm';

import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm';

// 图片处理
const photonInstance = await WebAssembly.instantiate(PHOTON_WASM, {
	'./photon_rs_bg.js': photon,
});
photon.setWasm(photonInstance.exports); // need patch

await initWebpWasm(WEBP_ENC_WASM);

const OUTPUT_FORMATS = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

// 支持的图片格式
const supportImages = ['png', 'jpg', 'jpeg', 'webp']
// const multipleImageMode = ['watermark', 'blend'];

const processImage = async (env, request, inputImage, pipeAction) => {
	const [action, options = ''] = pipeAction.split('!');
	let params = options.split(',');
	params = params.map( item => {
		if (item.startsWith('rgba_')) {
			const rgba = item.replace('rgba_', '').split('_').map(Number);
			return rgba.length === 4 ? new photon.Rgba( ...rgba ) :  new photon.Rgba(255, 255, 255, 255);
		} else {
			return item
		}
	})

	return photon[action](inputImage, ...params);
	/*if (multipleImageMode.includes(action)) {
		const image2 = params.shift(); // 是否需要 decodeURIComponent ?
		if (image2) {
			const image2Res = await fetch(image2, { headers: request.headers });
			if (image2Res.ok) {
				const inputImage2 = photon.PhotonImage.new_from_byteslice(new Uint8Array(await image2Res.arrayBuffer()));
				// 多图处理是处理原图
				photon[action](inputImage, inputImage2, ...params);
				return inputImage; // 多图模式返回第一张图
			}
		}
	} else {
		return photon[action](inputImage, ...params);
	}*/
};

/**
 * 生成居中裁剪的 @silvia-odwyer/photon 的 crop 命令。
 *
 * @param {number} originalWidth - 原图宽度。
 * @param {number} originalHeight - 原图高度。
 * @param {number} targetWidth - 目标裁剪宽度。
 * @param {number} targetHeight - 目标裁剪高度。
 * @returns {string} crop 命令字符串。
 */
function generateCropCommand(originalWidth, originalHeight, targetWidth, targetHeight) {
	let cropWidth, cropHeight;

	// 如果只提供宽度，则按比例计算高度
	if (targetWidth && !targetHeight) {
		cropWidth = Math.min(targetWidth, originalWidth);
		cropHeight = Math.round((cropWidth / originalWidth) * originalHeight);
	}
	// 如果只提供高度，则按比例计算宽度
	else if (!targetWidth && targetHeight) {
		cropHeight = Math.min(targetHeight, originalHeight);
		cropWidth = Math.round((cropHeight / originalHeight) * originalWidth);
	}
	// 如果同时提供宽度和高度，则按指定的宽高进行裁剪
	else if (targetWidth && targetHeight) {
		cropWidth = Math.min(targetWidth, originalWidth);
		cropHeight = Math.min(targetHeight, originalHeight);
	}
	// 如果宽度和高度都没有提供，直接返回原图尺寸
	else {
		cropWidth = originalWidth;
		cropHeight = originalHeight;
	}

	// 计算居中裁剪的起点坐标
	const x1 = Math.max(0, Math.round((originalWidth - cropWidth) / 2));
	const y1 = Math.max(0, Math.round((originalHeight - cropHeight) / 2));

	// 计算裁剪的终点坐标
	const x2 = x1 + cropWidth;
	const y2 = y1 + cropHeight;

	return `crop!${x1},${y1},${x2},${y2}`;
}

/**
 * 生成等比缩放图片的 resize 和补白命令，格式为 resize!${resizedWidth},${resizedHeight}|padding_uniform!${padding},rgba(255,255,255,255)。
 *
 * @param {number} originalWidth - 原图宽度。
 * @param {number} originalHeight - 原图高度。
 * @param {number} targetWidth - 目标压缩宽度（可选，如果未指定，将按目标高度等比缩放）。
 * @param {number} targetHeight - 目标压缩高度（可选，如果未指定，将按目标宽度等比缩放）。
 * @returns {string} resize 命令字符串。
 */
function generateAspectRatioResizeCommand(originalWidth, originalHeight, targetWidth, targetHeight) {
	let resizedWidth, resizedHeight;

	// 如果只提供了 targetWidth 或 targetHeight，按比例调整另一个值
	if (targetWidth && !targetHeight) {
		resizedWidth = targetWidth;
		resizedHeight = Math.round((originalHeight / originalWidth) * targetWidth);
	} else if (!targetWidth && targetHeight) {
		resizedHeight = targetHeight;
		resizedWidth = Math.round((originalWidth / originalHeight) * targetHeight);
	} else if (targetWidth && targetHeight) {
		// 如果两者都提供了，按等比缩放到最适合的尺寸
		const widthRatio = targetWidth / originalWidth;
		const heightRatio = targetHeight / originalHeight;

		if (widthRatio < heightRatio) {
			resizedWidth = targetWidth;
			resizedHeight = Math.round(originalHeight * widthRatio);
		} else {
			resizedWidth = Math.round(originalWidth * heightRatio);
			resizedHeight = targetHeight;
		}
	} else {
		// 没有指定目标尺寸的情况下，返回原始尺寸
		resizedWidth = originalWidth;
		resizedHeight = originalHeight;
	}

	return `resize!${resizedWidth},${resizedHeight},5`;
}

/**
 * 程序入口
 */
export default {
	async fetch(request, env, context) {
		// 校验CORS
		let referer = request.headers.get('referer');
		// 允许*.webify.top访问
		const allowedOriginSuffix = '.webify.top';

		// 设置为默认的允许域名
		let allowOriginHeader = 'https://webify.top';
		if (referer) {
			// 去掉 / 避免查询不到
			referer = referer.endsWith('/') ? referer.slice(0, -1) : referer;
			if (referer.includes(allowedOriginSuffix)) {
				allowOriginHeader = referer;
			} else {
				// 允许本地调试的域名访问
				const arrowDomains = [
					"http://localhost:3000",
					"http://localhost:4000",
					"http://localhost:4300",
					"http://localhost:4400",
					"http://localhost:8848",
					"http://localhost:8787",
				];

				if (arrowDomains.includes(referer)) {
					allowOriginHeader = referer;
				} else {
					// 如果不符合允许的域名，返回 CORS 错误
					console.error("not allow cors origin: ", referer)
					// 如果 Origin 不符合条件，返回 CORS 错误
					return new Response('CORS policy: No Access', { status: 403 });
				}
			}
		}



		// 如果图片没有带参数直接返回
		let requestUrl = request.url;
		console.log('requestUrl', requestUrl);
		// 本地测试需要替换
		requestUrl = requestUrl.replace('http://127.0.0.1:8787', 'https://cdn.webify.top');

		// 必须是这个域名的请求，其他都是非法
		if (!requestUrl.includes('cdn.webify.top')) {
			return new Response('Forbidden Request', {
				status: 403,
			});
		}

		// 使用cdn访问图片
		// requestUrl = requestUrl.replace('https://img.webify.top', 'https://cdn.webify.top')

		// 读取缓存
		const cacheUrl = new URL(requestUrl);
		// 获取路径部分
		const pathname = cacheUrl.pathname;
		// 使用正则表达式或者split方法获取后缀名
		const extension = pathname.split('.').pop();
		// 不支持的图片后缀
		if (extension === '/' || !supportImages.includes(extension)) {
			return new Response('Request Invalid', {
				status: 404,
			});
		}

		const cacheKey = new Request(cacheUrl.toString());
		const cache = caches.default;
		const hasCache = await cache.match(cacheKey);
		if (hasCache) {
			return hasCache;
		}

		// 入参提取与校验
		// 从 URL 中解析查询参数
		const paths = requestUrl.split('?');
		const originalUrl = paths[0];
		const params = new URLSearchParams(paths[1]);

    // 获取图像宽高参数
		// 图片质量
		const width = parseInt(params.get('w'), 10) || 0;
		const height = parseInt(params.get('h'), 10) || 0;
		const mode = params.get('m') || 'contain';  // 获取裁剪模式
		const quality = parseInt(params.get('q'), 10) || 80;

		const f = params.get('f');  // 获取图片转换的格式
		let format = f && supportImages.includes(f) ? f : extension;
		if (!f) {
			const acceptHeader = request.headers.get('Accept');
			const supportsWebP = acceptHeader && acceptHeader.includes('image/webp');
			format = supportsWebP ? 'webp' : extension;
		}

		// 目标图片获取与检查
		let imageRes
		try {
			// 尝试从缓存中读取图片
			// 替换 public URL 为 Cloudflare R2 的内部访问路径

			// https://adc4d5cedab6dd101123347e185ad42b.r2.cloudflarestorage.com/webify
			const internalUrl = originalUrl.replace('https://cdn.webify.top', 'https://adc4d5cedab6dd101123347e185ad42b.r2.cloudflarestorage.com/webify');
			console.log('internalUrl: ', internalUrl);
			// const originalUrlKey = originalUrl + '?original';
			imageRes = await cache.match(internalUrl);
			if (!imageRes) {
				// 请求获取图片
				// 发起请求时添加 X-CF-Worker 标头，避免再次触发 Worker
				imageRes = await fetch(originalUrl, { headers: {
						...request.headers,
						'X-CF-Worker': 'true'
					}
				});
				if (!imageRes.ok) {
					return imageRes;
				}
				// 写入缓存
				context.waitUntil(cache.put(internalUrl, imageRes.clone()));
			} else {
				console.log('loading from cache: ', internalUrl);
			}
		} catch (e) {
			console.error(e);
			// 无法获取图片，返回错误
			return new Response('Request Server Error', {
				status: 500,
			});
		}
		// 根据url计算 action参数
		let action = ''
		const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
		let inputImage, outputImage;
		try {
			inputImage = photon.PhotonImage.new_from_byteslice(imageBytes);
			const originalWidth = inputImage.get_width();
			const originalHeight = inputImage.get_height();
			if (width > 0 || height > 0) {
				if (mode === 'cover') {
					// 居中裁剪 cover
					action += generateCropCommand(originalWidth, originalHeight, width, height)
				} else {
					// 等比压缩 contain
					action += generateAspectRatioResizeCommand(originalWidth, originalHeight, width, height)
				}
			}
			const pipe = action.split('|').filter(Boolean);
			outputImage = await pipe.filter(Boolean).reduce(async (result, pipeAction) => {
				result = await result;
				return (await processImage(env, request, result, pipeAction)) || result;
			}, inputImage);
			// 图片编码
			let outputImageData;
			if (format === 'jpeg' || format === 'jpg') {
				outputImageData = outputImage.get_bytes_jpeg(quality)
			} else if (format === 'png') {
				outputImageData = outputImage.get_bytes()
			} else {
				outputImageData = await encodeWebp(outputImage.get_image_data(), { quality });
			}
			// 返回体构造
			const imageResponse = new Response(outputImageData, {
				headers: {
					'content-type': OUTPUT_FORMATS[format],
					// 'cache-control': 'public,max-age=300' // 缓存5分钟测试
					'cache-control': 'public,max-age=2592000', // 缓存1个月
					'Access-Control-Allow-Origin': allowOriginHeader
				}
			});

			// 写入缓存
			context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
			return imageResponse;
		} catch (error) {
			console.error('process:error', error.name, error.message, error);
			return new Response(imageBytes || null, {
				headers: imageRes.headers,
				status: 'RuntimeError' === error.name ? 415 : 500,
			});
		} finally {
			// 释放资源
			inputImage.ptr && inputImage.free();
			outputImage.ptr && outputImage.free();
		}
	}
};
