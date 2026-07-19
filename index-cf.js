/**
 * TellusCN Cloudflare Worker 反代服务
 * 
 * 为 Tellus Minecraft Mod 提供国内加速的数据源代理
 * 支持高程数据、地表覆盖、天气、地理编码等所有数据源
 * 
 * 适配 Cloudflare Workers 平台
 */

// 数据源配置映射（与原版完全一致）
const DATA_SOURCES = {
  'elevation': {
    target: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
    cacheTtl: 86400 * 30,
  },
  'copernicus30': {
    target: 'https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  'copernicus90': {
    target: 'https://copernicus-dem-90m.s3.eu-central-1.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  'usgs': {
    target: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    cacheTtl: 86400 * 7,
  },
  'japangsi': {
    target: 'https://cyberjapandata.gsi.go.jp/xyz',
    cacheTtl: 86400 * 30,
  },
  'arcticdem': {
    target: 'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1',
    cacheTtl: 86400 * 30,
  },
  'rema': {
    target: 'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/rema/mosaics/v2.0',
    cacheTtl: 86400 * 30,
  },
  'landcover': {
    target: 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map',
    cacheTtl: 86400 * 30,
  },
  'weather': {
    target: 'https://api.open-meteo.com/v1',
    cacheTtl: 3600,
  },
  'geocoding': {
    target: 'https://nominatim.openstreetmap.org',
    cacheTtl: 86400 * 7,
  },
  'overpass': {
    target: 'https://overpass-api.de/api',
    cacheTtl: 3600,
    headers: {
      'User-Agent': 'TellusCN-Deno/1.0 (Minecraft Mod Data Proxy)',
    },
  },
  'landmask': {
    target: 'https://github.com/Yucareux/Tellus-Land-Polygons/releases/download/v1.0.0',
    cacheTtl: 86400 * 30,
  },
  's3': {
    target: 'https://s3.us-west-2.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  'tiles': {
    target: 'https://tile.openstreetmap.org',
    cacheTtl: 86400 * 7,
    headers: {
      'User-Agent': 'TellusCN-Deno/1.0 (Minecraft Mod Mirror)',
    },
  },
  'overture/roads': {
    target: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-02-18.0/transportation.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
  'overture/buildings': {
    target: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-02-18.0/buildings.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
  'overture/water': {
    target: 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2026-01-21/base.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
  'overture/sand': {
    target: 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2026-01-21/base.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
};

// CORS 响应头（与原版一致）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

/**
 * Cloudflare Worker 入口：使用 export default 替换 Deno.serve
 */
export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 只处理 GET 和 HEAD 请求
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { 
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 健康检查端点
      if (path === '/health' || path === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'TellusCN Cloudflare Worker',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          sources: Object.keys(DATA_SOURCES),
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        });
      }

      // 解析路由 /:source/*
      const pathParts = path.split('/').filter(p => p);
      if (pathParts.length < 1) {
        return new Response('Not Found: Please use /{source}/* format', { 
          status: 404,
          headers: CORS_HEADERS,
        });
      }

      // 尝试匹配多级路由（如 overture/roads）
      let sourceKey = pathParts[0];
      let sourceConfig = DATA_SOURCES[sourceKey];
      if (!sourceConfig && pathParts.length >= 2) {
        const multiLevelKey = pathParts[0] + '/' + pathParts[1];
        if (DATA_SOURCES[multiLevelKey]) {
          sourceKey = multiLevelKey;
          sourceConfig = DATA_SOURCES[multiLevelKey];
        }
      }

      if (!sourceConfig) {
        return new Response(
          `Unknown data source: ${sourceKey}. Available: ${Object.keys(DATA_SOURCES).join(', ')}`,
          { status: 404, headers: CORS_HEADERS }
        );
      }

      // 获取 Range 请求头
      const rangeHeader = request.headers.get('Range');

      // 构建目标 URL
      let targetUrl;
      if (sourceConfig.rewritePath) {
        // 对于 Overture Maps 等单文件数据源，直接使用 target 作为完整 URL
        targetUrl = sourceConfig.target + url.search;

        // 大文件（如 PMTiles）直接 302 重定向，避免 Worker 内存/超时问题
        if (!rangeHeader) {
          console.log(`Redirecting to: ${targetUrl}`);
          return new Response(null, {
            status: 302,
            statusText: 'Found',
            headers: {
              'Location': targetUrl,
              'X-Proxy-By': 'TellusCN-CF-Worker',
              'X-Redirect-Reason': 'Large file - direct download',
              'Content-Length': '0',
              ...CORS_HEADERS,
            },
          });
        }
      } else {
        // 正常情况：target + 请求路径
        const pathOffset = sourceKey.includes('/') ? 2 : 1;
        const targetPath = '/' + pathParts.slice(pathOffset).join('/');
        targetUrl = sourceConfig.target + targetPath + url.search;
      }

      // ========== 关键改动：使用 caches.default 代替 caches.open ==========
      const cache = caches.default; // Cloudflare 默认缓存，兼容性最佳

      // 创建缓存键（包含 Range 信息）
      const cacheKeyUrl = rangeHeader 
        ? `${targetUrl}#range=${rangeHeader.replace(/[^0-9-]/g, '')}`
        : targetUrl;
      const cacheKey = new Request(cacheKeyUrl, { method: request.method });

      // 尝试从缓存获取
      let response = await cache.match(cacheKey);

      if (response) {
        // 添加缓存命中标记并返回
        const cachedResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        cachedResponse.headers.set('X-Cache', 'HIT');
        cachedResponse.headers.set('X-Cache-Source', sourceKey);
        return addCorsHeaders(cachedResponse);
      }

      // 从源站获取（12秒超时）
      const fetchOptions = {
        method: request.method,
        headers: {
          'User-Agent': 'TellusCN-CF-Worker/1.0 (Minecraft Mod Proxy)',
          'Accept': request.headers.get('Accept') || '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      };

      // 应用数据源自定义 headers
      if (sourceConfig.headers) {
        Object.entries(sourceConfig.headers).forEach(([key, value]) => {
          fetchOptions.headers[key] = value;
        });
      }

      if (rangeHeader) {
        fetchOptions.headers['Range'] = rangeHeader;
      }

      // 带超时的 fetch
      const fetchPromise = fetch(targetUrl, fetchOptions);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('FETCH_TIMEOUT')), 12000);
      });

      try {
        response = await Promise.race([fetchPromise, timeoutPromise]);
      } catch (error) {
        if (error.message === 'FETCH_TIMEOUT') {
          console.error(`Fetch timeout: ${targetUrl}`);
          return new Response('Gateway Timeout: Source took too long', {
            status: 504,
            headers: CORS_HEADERS,
          });
        }
        throw error;
      }

      // 处理源站错误响应
      if (!response.ok && response.status !== 206) {
        console.error(`Source error: ${response.status} for ${targetUrl}`);
        return new Response(`Source Error: ${response.status}`, {
          status: response.status,
          headers: CORS_HEADERS,
        });
      }

      // 构建缓存友好响应头（移除 content-encoding 等可能冲突的头）
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding' && 
            key.toLowerCase() !== 'content-length') {
          responseHeaders.set(key, value);
        }
      });
      responseHeaders.set('X-Cache', 'MISS');
      responseHeaders.set('X-Cache-Source', sourceKey);
      responseHeaders.set('X-Proxy-By', 'TellusCN-CF-Worker');
      responseHeaders.set('Cache-Control', `public, max-age=${sourceConfig.cacheTtl}`);

      const responseToReturn = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      // 只有非 206 响应才能被 Cloudflare Cache 有效缓存
      if (response.status !== 206) {
        try {
          // Cloudflare 的 put 同样接受 (request, response)
          await cache.put(cacheKey, responseToReturn.clone());
        } catch (cacheError) {
          console.error(`Cache put error: ${cacheError.message}`);
        }
      }

      return addCorsHeaders(responseToReturn);

    } catch (error) {
      console.error('Cloudflare Worker error:', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};

/**
 * 添加 CORS 响应头
 */
function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
