/*!
 * Butterfly Liquid Glass — portable edition
 * ---------------------------------------------------------------------------
 * 把 Hexo Butterfly 主题的所有面板改造成带真实折射的液态玻璃。
 * 不需要 fork 主题，不需要构建工具，一个文件搞定。
 *
 * 用法：和 glass.css 一起注入到 _config.butterfly.yml 的 inject 里。
 *
 * 原理：用有符号距离场算出每个像素的表面斜率，编码成一张位移贴图，
 *       交给 SVG feDisplacementMap 去弯曲 backdrop。
 *
 * 授权：MIT
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK  = 'http://www.w3.org/1999/xlink';

  var MAX_MAP     = 192;  /* 贴图最大边长；距离场平滑，低分辨率拉伸后看不出来 */
  var SIZE_STEP   = 8;    /* 尺寸量化，让同尺寸的卡片共用一张贴图 */
  var CACHE_LIMIT = 48;

  /* ---------------------------------------------------------------
     Butterfly 选择器 → 玻璃权重
     换主题只需要改这张表。
     --------------------------------------------------------------- */
  var SURFACES = [
    ['#nav',                                            'glass--soft'],
    ['#rightside > div > button, #rightside > button',  'glass--soft'],
    ['#pagination .page-number, #pagination .extend',   'glass--soft'],
    ['.tag-cloud-list a',                               'glass--soft'],
    ['#article-container .tag-list a',                  'glass--soft'],
    ['#post .post-copyright',                           'glass--soft'],
    ['#footer-wrap',                                    'glass--soft'],
    /* Butterfly 5.7.0 的页脚是 #footer，#footer-wrap 不存在 */
    ['#footer',                                         'glass--soft'],
    ['.pagination-post .pagination-related',            'glass--soft'],
    ['.relatedPosts .relatedPosts-list .pagination-related', 'glass--soft'],
    ['#archive .article-sort-item:not(.year)',          'glass--soft'],
    /* 友链页的每个友链块，规格与归档页每篇文章的行一致 */
    ['.container .flink .flink-list-item',             'glass--soft'],

    ['#aside-content .card-widget',                     'glass--medium'],
    ['#card-toc, #toc-div',                             'glass--medium'],
    ['#article-container .note',                        'glass--medium'],

    ['#recent-posts .recent-post-item',                 'glass--strong'],
    ['#post, #page, #archive, #tag, #category',         'glass--strong'],

    ['#article-container figure.highlight',             'glass--dense'],
    ['#article-container pre:not(figure.highlight pre)','glass--dense'],
    ['#article-container blockquote',                   'glass--dense'],
    ['#article-container .table-wrap',                  'glass--dense'],

    ['#local-search .search-dialog, .search-dialog',    'glass--floating'],
    ['#sidebar-menus',                                  'glass--floating']
  ];

  /* ---------------------------------------------------------------
     能力检测
     只有 Chromium 会在 backdrop-filter 里合成 SVG 滤镜；
     Safari / Firefox 解析后会静默丢弃整条声明，连 blur 都没了。
     --------------------------------------------------------------- */
  function backdropSupported() {
    if (!window.CSS || !CSS.supports) return false;
    return CSS.supports('backdrop-filter', 'blur(1px)') ||
           CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  }

  function chromiumLike() {
    var uad = navigator.userAgentData;
    if (uad && uad.brands && uad.brands.length) {
      for (var i = 0; i < uad.brands.length; i++) {
        if (/Chromium/i.test(uad.brands[i].brand)) return true;
      }
      return false;
    }
    var ua = navigator.userAgent;
    /* CriOS / FxiOS / EdgiOS 是套壳 WebKit */
    if (/CriOS|FxiOS|EdgiOS/.test(ua)) return false;
    return /Chrome\/|Chromium\/|Edg\//.test(ua);
  }

  var mqReduce = window.matchMedia('(prefers-reduced-transparency: reduce)');
  var refract  = backdropSupported() && chromiumLike() && !mqReduce.matches;

  /* ---------------------------------------------------------------
     距离场 → 位移贴图
     --------------------------------------------------------------- */
  function roundedRectSDF(x, y, hw, hh, r) {
    var qx = Math.abs(x) - hw + r;
    var qy = Math.abs(y) - hh + r;
    var mx = Math.max(qx, 0), my = Math.max(qy, 0);
    return Math.min(Math.max(qx, qy), 0) + Math.sqrt(mx * mx + my * my) - r;
  }

  function buildMap(o) {
    var w = o.w, h = o.h;
    if (!(w > 0 && h > 0)) return null;

    var k  = Math.min(1, MAX_MAP / Math.max(w, h));
    var mw = Math.max(8, Math.round(w * k));
    var mh = Math.max(8, Math.round(h * k));

    var hw = w / 2, hh = h / 2;
    var r  = Math.max(0, Math.min(o.radius || 0, Math.min(hw, hh)));
    var bezel = Math.max(2, Math.min(o.bezel, Math.min(hw, hh)));
    var strength = o.refraction;
    if (strength <= 0.01) return null;

    var depth = Math.max(1, o.edgeDepth);
    /* 圆弧倒角截面：边缘处斜率最大。用 smoothstep 会在边缘变平，
       那描述的是平切角，做出来的边看起来是「切」的不是「弯」的。 */
    var lensK    = 1 - 1 / (1 + depth * depth);
    var lensNorm = Math.sqrt(1 - lensK);
    var gate     = bezel * 0.35;

    var offs = new Float32Array(mw * mh * 2);
    var peak = 0, e = 1;

    for (var j = 0; j < mh; j++) {
      var py = ((j + 0.5) / mh) * h - hh;
      for (var i = 0; i < mw; i++) {
        var px = ((i + 0.5) / mw) * w - hw;
        var d  = roundedRectSDF(px, py, hw, hh, r);

        var u = (d + bezel) / bezel;
        if (u <= 0) continue;
        if (u > 1) u = 1;
        var t = u * lensNorm / Math.sqrt(1 - u * u * lensK);
        if (d + bezel < gate) {
          var g = (d + bezel) / gate;
          t *= g * g * (3 - 2 * g);
        }
        if (t <= 0.0005) continue;

        /* 中心差分求梯度。解析解快 3.8 倍，但会在圆角的角平分线上
           产生 90° 硬翻转（那里是距离场的真实尖点），留下折痕。 */
        var gx = roundedRectSDF(px + e, py, hw, hh, r) -
                 roundedRectSDF(px - e, py, hw, hh, r);
        var gy = roundedRectSDF(px, py + e, hw, hh, r) -
                 roundedRectSDF(px, py - e, hw, hh, r);
        var len = Math.sqrt(gx * gx + gy * gy);
        if (len < 1e-6) continue;

        var amt = t * strength;
        var p = (j * mw + i) * 2;
        offs[p]     = -(gx / len) * amt;
        offs[p + 1] = -(gy / len) * amt;
        if (Math.abs(offs[p])     > peak) peak = Math.abs(offs[p]);
        if (Math.abs(offs[p + 1]) > peak) peak = Math.abs(offs[p + 1]);
      }
    }
    if (peak < 0.01) return null;

    var canvas = document.createElement('canvas');
    canvas.width = mw; canvas.height = mh;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(mw, mh);
    var data = img.data;

    /* scale = 2*peak，这样 0.5 ± off/(2*peak) 能被
       feDisplacementMap 的 (C - 0.5) * scale 精确还原 */
    var scale = peak * 2;
    for (var n = 0, q = 0; n < data.length; n += 4, q += 2) {
      data[n]     = (0.5 + offs[q]     / scale) * 255;
      data[n + 1] = (0.5 + offs[q + 1] / scale) * 255;
      data[n + 2] = 0;
      data[n + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { url: canvas.toDataURL(), scale: scale };
  }

  /* ---------------------------------------------------------------
     滤镜构建与缓存
     --------------------------------------------------------------- */
  var host = null;
  function defs() {
    if (host && host.isConnected) return host.firstChild;
    host = document.createElementNS(SVG_NS, 'svg');
    host.setAttribute('width', '0');
    host.setAttribute('height', '0');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none';
    host.appendChild(document.createElementNS(SVG_NS, 'defs'));
    document.body.appendChild(host);
    return host.firstChild;
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        node.setAttribute(k, String(attrs[k]));
      }
    }
    return node;
  }

  var cache = new Map(), held = new WeakMap(), seq = 0;

  function buildFilter(filter, map, aberration) {
    var feImage = el('feImage', { result: 'map', preserveAspectRatio: 'none' });
    feImage.setAttribute('href', map.url);
    feImage.setAttributeNS(XLINK, 'xlink:href', map.url);
    filter.appendChild(feImage);

    if (!aberration || aberration <= 0.001) {
      filter.appendChild(el('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'map', scale: map.scale,
        xChannelSelector: 'R', yChannelSelector: 'G'
      }));
      return feImage;
    }

    /* 色散：红偏折最多，蓝最少，三路各留一个通道再相加。
       注意每一路都要「保留 alpha」——SVG 滤镜在预乘 alpha 空间运算，
       把 alpha 归零会连颜色一起乘没，结果是整个页面渲染成纯绿色。 */
    var scales = [map.scale * (1 + aberration), map.scale, map.scale * (1 - aberration)];
    var keep = [
      '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
    ];
    var ch = ['R', 'G', 'B'];
    for (var i = 0; i < 3; i++) {
      filter.appendChild(el('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'map', scale: scales[i],
        xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + ch[i]
      }));
      filter.appendChild(el('feColorMatrix', {
        in: 'd' + ch[i], type: 'matrix', values: keep[i], result: 'c' + ch[i]
      }));
    }
    filter.appendChild(el('feComposite', {
      in: 'cR', in2: 'cG', operator: 'arithmetic',
      k1: 0, k2: 1, k3: 1, k4: 0, result: 'cRG'
    }));
    filter.appendChild(el('feComposite', {
      in: 'cRG', in2: 'cB', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0
    }));
    return feImage;
  }

  function num(cs, prop, fallback) {
    var v = parseFloat(cs.getPropertyValue(prop));
    return isNaN(v) ? fallback : v;
  }

  function apply(element) {
    if (!refract) return;
    var rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 16) return;

    var w = Math.ceil(rect.width  / SIZE_STEP) * SIZE_STEP;
    var h = Math.ceil(rect.height / SIZE_STEP) * SIZE_STEP;

    var cs = getComputedStyle(element);
    /* 贴图是单一圆角矩形，四角不同时取最大的那个 */
    var radius = Math.max(
      parseFloat(cs.borderTopLeftRadius)     || 0,
      parseFloat(cs.borderTopRightRadius)    || 0,
      parseFloat(cs.borderBottomRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius)  || 0
    );
    if (radius > Math.min(w, h) / 2) radius = Math.min(w, h) / 2;

    var o = {
      w: w, h: h, radius: radius,
      refraction: num(cs, '--glass-refraction', 60),
      bezel:      num(cs, '--glass-bezel-width', 40),
      edgeDepth:  num(cs, '--glass-edge-depth', 1.8),
      aberration: num(cs, '--glass-chromatic', 0)
    };

    var key = [o.w, o.h, o.radius, o.bezel, o.refraction,
               o.edgeDepth, o.aberration].join('|');
    if (held.get(element) === key && element.style.getPropertyValue('--g-filter')) return;

    var entry = cache.get(key);
    if (!entry) {
      var map = buildMap(o);
      if (!map) { element.style.removeProperty('--g-filter'); return; }
      var id = 'bfglass-' + (++seq);
      var filter = el('filter', {
        id: id, filterUnits: 'userSpaceOnUse',
        'color-interpolation-filters': 'sRGB',
        x: 0, y: 0, width: o.w, height: o.h
      });
      var feImage = buildFilter(filter, map, o.aberration);
      feImage.setAttribute('x', 0);      feImage.setAttribute('y', 0);
      feImage.setAttribute('width', o.w); feImage.setAttribute('height', o.h);
      defs().appendChild(filter);
      entry = { id: id, node: filter };
      cache.set(key, entry);

      if (cache.size > CACHE_LIMIT) {
        var first = cache.keys().next().value;
        var old = cache.get(first);
        if (old && old !== entry) { old.node.remove(); cache.delete(first); }
      }
    }
    held.set(element, key);
    element.style.setProperty('--g-filter', 'url(#' + entry.id + ')');
  }

  /* ---------------------------------------------------------------
     打标 + 生命周期
     --------------------------------------------------------------- */
  var tagged = [];

  /* 元素尺寸变了，贴图就得重算。
     最典型的场景是长代码块的「展开」按钮：点一下高度从 460px 变成完整高度，
     而滤镜是按旧尺寸缓存的——不重算的话折射带会停在原来的位置，
     看起来就是一条横在代码中间的畸变。窗口 resize 事件覆盖不到这种情况。 */
  var ro = window.ResizeObserver ? new ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) apply(entries[i].target);
  }) : null;

  function tag() {
    SURFACES.forEach(function (pair) {
      var nodes;
      try { nodes = document.querySelectorAll(pair[0]); }
      catch (err) { return; }   /* 这个 Butterfly 版本没有这个选择器 */
      for (var i = 0; i < nodes.length; i++) {
        var element = nodes[i];
        if (element.classList.contains('glass')) continue;
        element.classList.add('glass');
        pair[1].split(' ').forEach(function (c) { if (c) element.classList.add(c); });
        tagged.push(element);
        apply(element);
        if (ro) ro.observe(element);
      }
    });
  }

  function refreshAll() {
    tagged = tagged.filter(function (e) { return e.isConnected; });
    tagged.forEach(apply);
  }

  var root = document.documentElement;
  root.classList.add('glass-ready');
  root.classList.add(refract ? 'glass-refract' : 'glass-plain');

  function boot() {
    tag();
    /* Butterfly 在 DOMContentLoaded 之后还会改 DOM：
       把宽表格包进 .table-wrap、构建目录。所以要补扫。 */
    setTimeout(tag, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.addEventListener('load', function () { tag(); setTimeout(tag, 400); });

  /* pjax 切页后整个 DOM 换了，要重新打标 */
  ['pjax:complete', 'pjax:success'].forEach(function (evt) {
    document.addEventListener(evt, function () {
      if (ro) ro.disconnect();
      tagged = [];
      tag();
      setTimeout(tag, 400);
    });
  });

  /* 尺寸变了贴图要重算，但一定要防抖 */
  var timer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(refreshAll, 180);
  });

  /* Butterfly 切换深浅色时改 <html> 的 data-theme */
  new MutationObserver(refreshAll).observe(root, {
    attributes: true, attributeFilter: ['data-theme']
  });

  window.butterflyGlass = { retag: tag, refresh: refreshAll, surfaces: SURFACES };
})();
