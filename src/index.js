import queryString from 'query-string';

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

const multipleImageMode = ['watermark', 'blend'];

// const inWhiteList = (env, url) => {
// 	const imageUrl = new URL(url);
// 	const whiteList = env.WHITE_LIST ? env.WHITE_LIST.split(',') : [];
// 	return !(whiteList.length && !whiteList.find((hostname) => imageUrl.hostname.endsWith(hostname)));
// };

const processImage = async (env, request, inputImage, pipeAction) => {
	const [action, options = ''] = pipeAction.split('!');
	let params = options.split(',');

	params = params.map( item => {
		if (item.startsWith('rgba_')) {
			const rgba = item.replace('rgba_', '').split('_');
			if (rgba.length === 4) {
				return new photon.Rgba( ...rgba );
			} else {
				return new photon.Rgba(255, 255, 255, 255)
			}
		} else {
			return item
		}
	})

	if (multipleImageMode.includes(action)) {
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
	}
};

function isNumeric(value) {
	return !isNaN(value) && !isNaN(parseFloat(value));
}

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
	let cropWidth, cropHeight, padding;
	// let padX = 0, padY = 0, padLeft = 0, padRight = 0, padTop = 0, padBottom = 0;

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

		// if (targetWidth > originalWidth || targetHeight > originalHeight) {
		// 	// 计算填充尺寸
		// 	padX = Math.max(0, targetWidth - cropWidth);
		// 	padY = Math.max(0, targetHeight - cropHeight);
		// 	// 计算左右和上下的补白
		// 	if (padX > 0) {
		// 		padLeft = Math.floor(padX / 2);
		// 		padRight = padX - padLeft;
		// 	} else if (padY > 0) {
		// 		padTop = Math.floor(padY / 2);
		// 		padBottom = padY - padTop;
		// 	}
		// }
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

	// 返回 crop 命令字符串，格式为 crop!${x1},${y1},${x2},${y2}
	// let command = `crop!${x1},${y1},${x2},${y2}`;
	// console.log('padding:', padding)
	// if (padX === 0 && padY === 0) {
	// 	return command;
	// }
	//
	// // 如果需要补白，添加四边补白命令
	// const rgba= 'rgba_0_0_0_0'
	// if (padLeft > 0) {
	// 	command += `|padding_left!${padLeft},${rgba}`;
	// }
	// if (padRight > 0) {
	// 	command += `|padding_right!${padRight},${rgba}`;
	// }
	// if (padTop > 0) {
	// 	command += `|padding_top!${padTop},${rgba}`;
	// }
	// if (padBottom > 0) {
	// 	command += `|padding_bottom!${padBottom},${rgba}`;
	// }
	//
	// return command;
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
	// let padX = 0, padY = 0, padLeft = 0, padRight = 0, padTop = 0, padBottom = 0;

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

		// 计算补白的像素数
		/*padX = Math.max(0, targetWidth - resizedWidth);
		padY = Math.max(0, targetHeight - resizedHeight);
    // 计算左右和上下的补白
		if (padX > 0) {
			padLeft = Math.floor(padX / 2);
			padRight = padX - padLeft;
		} else if (padY > 0) {
			padTop = Math.floor(padY / 2);
			padBottom = padY - padTop;
		}*/
	} else {
		// 没有指定目标尺寸的情况下，返回原始尺寸
		resizedWidth = originalWidth;
		resizedHeight = originalHeight;
	}

	return `resize!${resizedWidth},${resizedHeight},5`;

	// 生成 resize 命令
	/*let resizeCommand = `resize!${resizedWidth},${resizedHeight},5`;
	if (padX === 0 && padY === 0) {
		return resizeCommand;
	}

	// 如果需要补白，添加四边补白命令
	const rgba= 'rgba_0_0_0_0'
	if (padLeft > 0) {
		resizeCommand += `|padding_left!${padLeft},${rgba}`;
	}
	if (padRight > 0) {
		resizeCommand += `|padding_right!${padRight},${rgba}`;
	}
	if (padTop > 0) {
		resizeCommand += `|padding_top!${padTop},${rgba}`;
	}
	if (padBottom > 0) {
		resizeCommand += `|padding_bottom!${padBottom},${rgba}`;
	}

	// 返回 resize 命令字符串
	return resizeCommand;*/
}

/**
 * 程序入口
 */
export default {
	async fetch(request, env, context) {
		console.log('request:', request.url);

		// 如果图片没有带参数直接返回
		let requestUrl = request.url;
		requestUrl = requestUrl.replace('http://127.0.0.1:8787', 'https://img.webify.top');

		// 必须是这个域名的请求，其他都是非法
		if (!requestUrl.includes('img.webify.top')) {
			return new Response('Forbidden Request', {
				status: 403,
			});
		}

		// 读取缓存
		const cacheUrl = new URL(request.url);
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
			console.log('cache: true');
			return hasCache;
		}

		// 入参提取与校验
		const query = queryString.parse(cacheUrl.search);
		const { f, q= 80 } = query;

		// 图片质量
		const quality = q;
		const url = requestUrl

		console.log('extension:', extension)

		let format
		if (f && supportImages.includes(f)) {
			format = f;
		} else {
			// 获取请求头中的 Accept 字段
			const acceptHeader = request.headers.get('Accept');
			console.log('acceptHeader:', acceptHeader)
			// 判断是否支持 WebP 格式
			const supportsWebP = acceptHeader && acceptHeader.includes('image/webp');
			console.log('supportsWebP:', supportsWebP)
			if (supportsWebP) {
				format = 'webp'
			} else {
				format = extension
			}
		}

		console.log('params:', url, format, quality);

		// 目标图片获取与检查
		let imageRes
		try {
			imageRes = await fetch(url, { headers: request.headers });
			if (!imageRes.ok) {
				return imageRes;
			}
		} catch (e) {
			console.error(e);
			// 无法获取图片，返回错误
			return new Response('Request Server Error', {
				status: 500,
			});
		}
		console.log('fetch image done');

		// 根据url计算 action参数
		let action = ''

		const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
		try {
			const inputImage = photon.PhotonImage.new_from_byteslice(imageBytes);
			console.log('create inputImage done, width:', inputImage.get_width(), 'height:', inputImage.get_height());
			let { w, h, m = 'contain' } = query

			const mode = m;
			const originalWidth = inputImage.get_width();
			const originalHeight = inputImage.get_height();
			let targetWidth, targetHeight
			if (isNumeric(w)) {
				targetWidth = parseFloat(w)
			}
			if (isNumeric(h)) {
				targetHeight = parseFloat(h)
			}

			if (targetWidth || targetHeight) {
				// targetWidth = targetWidth || originalWidth
				// targetHeight = targetHeight || originalHeight

				if (mode === 'cover') {
					// 居中裁剪 cover
					action += generateCropCommand(originalWidth, originalHeight, targetWidth, targetHeight)
				} else {
					// 等比压缩 contain
					action += generateAspectRatioResizeCommand(originalWidth, originalHeight, targetWidth, targetHeight)
				}
			}

			console.log('=====actions:', action)
			/** pipe
			 * `resize!800,400,1|watermark!https%3A%2F%2Fmt.ci%2Flogo.png,10,10,10,10`
			 */

			const pipe = action.split('|');
			const outputImage = await pipe.filter(Boolean).reduce(async (result, pipeAction) => {
				result = await result;
				return (await processImage(env, request, result, pipeAction)) || result;
			}, inputImage);
			console.log('create outputImage done');

			// 图片编码
			let outputImageData;
			if (format === 'jpeg' || format === 'jpg') {
				outputImageData = outputImage.get_bytes_jpeg(quality)
			} else if (format === 'png') {
				outputImageData = outputImage.get_bytes()
			} else {
				outputImageData = await encodeWebp(outputImage.get_image_data(), { quality });
			}
			console.log('create outputImageData done');

			// 返回体构造
			const imageResponse = new Response(outputImageData, {
				headers: {
					'content-type': OUTPUT_FORMATS[format],
					'cache-control': 'public,max-age=300' // 缓存5分钟测试
					// 'cache-control': 'public,max-age=2592000', // 缓存1个月
				}
			});

			// 释放资源
			inputImage.ptr && inputImage.free();
			outputImage.ptr && outputImage.free();
			console.log('image free done');

			// 写入缓存
			context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
			return imageResponse;
		} catch (error) {
			console.error('process:error', error.name, error.message, error);
			const errorResponse = new Response(imageBytes || null, {
				headers: imageRes.headers,
				status: 'RuntimeError' === error.name ? 415 : 500,
			});
			return errorResponse;
		}
	},
};
