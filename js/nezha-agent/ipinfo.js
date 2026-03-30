(function() {
  // 防重复运行（SPA/多次注入）
  if (window.__NEZHA_IP_BAR_INITED__) return;
  window.__NEZHA_IP_BAR_INITED__ = true;

  const STYLE_ID = 'nezha-ip-bar-style';
  const BAR_ID = 'ip-bar';

  const CACHE_KEY = 'nezha_ip_bar_cache_v6';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6小时缓存

  // 距离页面底部 <= 这个像素时隐藏（想更早隐藏就调大）
  const BOTTOM_HIDE_PX = 24;

  // ====== 仅电脑端显示“详细信息”(ASN/运营商/延迟/↓Mbps) ======
  const isDesktop = (() => {
    const ua = navigator.userAgent || '';
    const hasTouch = (navigator.maxTouchPoints || 0) > 0;
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const isIPadDesktopMode = /Macintosh/i.test(ua) && hasTouch;
    return !isMobileUA && !isIPadDesktopMode;
  })();

  const injectStyle = (css) => {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const fetchWithTimeout = async (url, timeoutMs = 4000, opt = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        ...opt
      });
      if (!res.ok) throw new Error('Response not OK');
      return res;
    } finally {
      clearTimeout(t);
    }
  };

  // Promise.any 兼容兜底
  const promiseAny = (promises) => {
    if (Promise.any) return Promise.any(promises);
    return new Promise((resolve, reject) => {
      let rejects = 0;
      const errors = [];
      promises.forEach((p, i) => {
        Promise.resolve(p).then(resolve).catch(err => {
          errors[i] = err;
          rejects += 1;
          if (rejects === promises.length) {
            reject(new AggregateError(errors, 'All promises were rejected'));
          }
        });
      });
    });
  };

  // 并发竞速：谁先成功返回用谁（且必须能解析到 ip 字段）
  const fetchRaceJson = async (urls, timeoutMs = 4000) => {
    const controllers = urls.map(() => new AbortController());
    const timers = controllers.map(c => setTimeout(() => c.abort(), timeoutMs));

    const tasks = urls.map((url, i) =>
      fetch(url, {
        signal: controllers[i].signal,
        credentials: 'omit',
        cache: 'no-store'
      }).then(async res => {
        if (!res.ok) throw new Error('Response not OK');
        const j = await res.json();
        const ip = j?.ip || j?.query;
        if (!ip) throw new Error('No IP in response');
        return j;
      })
    );

    try {
      const first = await promiseAny(tasks);
      controllers.forEach(c => { try { c.abort(); } catch {} });
      return first;
    } finally {
      timers.forEach(t => clearTimeout(t));
    }
  };

  // 单点测速（no-cors 不读响应体，只计时）
  const pingOnce = async (target, timeoutMs = 1500) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();
    try {
      await fetch(target.url, {
        signal: controller.signal,
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit'
      });
      return { name: target.name, ms: Math.round(performance.now() - start) };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  // 双点并发竞速：谁先成功用谁
  const pingRace2 = async (a, b, timeoutMs = 1500) => {
    const controllers = [new AbortController(), new AbortController()];
    const timers = controllers.map(c => setTimeout(() => c.abort(), timeoutMs));

    const tasks = [a, b].map((tgt, i) => {
      const start = performance.now();
      return fetch(tgt.url, {
        signal: controllers[i].signal,
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit'
      }).then(() => ({ name: tgt.name, ms: Math.round(performance.now() - start) }));
    });

    try {
      const first = await promiseAny(tasks);
      controllers.forEach(c => { try { c.abort(); } catch {} });
      return first;
    } catch {
      return null;
    } finally {
      timers.forEach(t => clearTimeout(t));
    }
  };

  const normalize = (data) => {
    const ip = data?.ip || data?.query;

    const country = data?.country_name || data?.country || '';
    const city = data?.city || '';
    const region = data?.region || data?.regionName || '';
    const finalCity = city || region || '';
    const loc = (country && finalCity && country !== finalCity)
      ? `${country} · ${finalCity}`
      : (country || finalCity);

    const asn =
      data?.asn ||
      (typeof data?.org === 'string' && /^AS\d+\b/i.test(data.org) ? (data.org.match(/^AS\d+\b/i)?.[0] || '') : '') ||
      (typeof data?.as === 'string' ? (data.as.match(/^AS\d+\b/i)?.[0] || '') : '') ||
      '';

    const org =
      data?.org ||
      data?.organization ||
      data?.isp ||
      (typeof data?.as === 'string' ? data.as.replace(/^AS\d+\s*/i, '') : '') ||
      '';

    return { ip, loc, asn, org };
  };

  const latencyClass = (ms) => {
    if (!Number.isFinite(ms)) return '';
    if (ms < 80) return 'lat-excellent';   // 绿
    if (ms < 150) return 'lat-good';       // 蓝
    if (ms < 300) return 'lat-mid';        // 橙
    return 'lat-bad';                      // 红
  };

  const getDownlinkStr = () => {
    // 只保留 ↓Mbps（不显示 4G/网络类型）
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c || typeof c.downlink !== 'number' || !isFinite(c.downlink)) return '';
    const dl = c.downlink >= 10 ? Math.round(c.downlink) : Math.round(c.downlink * 10) / 10;
    return `↓${dl}Mbps`;
  };

  const formatBaseText = ({ ip, loc, asn, org }) => {
    if (!ip) return '无法解析IP信息';

    const isIPv4 = ip.includes('.') && !ip.includes(':');
    const netLabel = isIPv4 ? ip : 'IPv6 network';

    // 移动端：只显示地区
    if (!isDesktop) {
      return loc ? `${netLabel} ｜ ${loc}` : netLabel;
    }

    // 电脑端：地区 + ASN/运营商
    const parts = [];
    if (loc) parts.push(loc);
    const asnOrg = [asn, org].filter(Boolean).join(' ');
    if (asnOrg) parts.push(asnOrg);

    return parts.length ? `${netLabel} ｜ ${parts.join(' ｜ ')}` : netLabel;
  };

  const loadCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || !obj.base) return null;
      if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
      return obj.base;
    } catch {
      return null;
    }
  };

  const saveCache = (base) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), base }));
    } catch {}
  };

  // 当前显示的是哪个点（用于点击切换）
  let currentProbe = ''; // 'Google' | 'CF'
  let isSwitching = false;

  const ensureBar = () => {
    injectStyle(`
      #${BAR_ID} {
        position: fixed;
        left: 50%;
        bottom: 12px;
        transform: translateX(-50%);
        z-index: 9999;
        transition: opacity .25s ease, transform .25s ease;
      }
      #${BAR_ID}.ip-hidden {
        opacity: 0;
        transform: translateX(-50%) translateY(18px);
        pointer-events: none;
      }
      #${BAR_ID} .ip-inner {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        border-radius: 999px;
        background: rgba(255,255,255,.96);
        box-shadow: 0 8px 30px rgba(0,0,0,0.15);
        backdrop-filter: blur(16px);
        border: 1px solid rgba(220,220,220,.9);
        max-width: calc(100vw - 24px);
      }
      #${BAR_ID} .ip-icon {
        width: 20px;
        height: 20px;
        border-radius: 999px;
        border: 2px solid #1a73e8;
        position: relative;
        flex: 0 0 auto;
      }
      #${BAR_ID} .ip-icon::before {
        content: "";
        position: absolute;
        inset: 4px;
        border-radius: inherit;
        background: #1a73e8;
      }
      #${BAR_ID} .ip-text {
        font-size: 14px;
        color: #333;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: calc(100vw - 90px);
      }
      #${BAR_ID} .ip-l { color: #1a73e8; font-weight: 600; margin-right: 4px; }

      /* 延迟区域：可点击 + 渐变切换动画 */
      #${BAR_ID} .ip-net {
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        transition: opacity .22s ease, transform .22s ease, filter .22s ease;
        will-change: opacity, transform;
      }
      #${BAR_ID} .ip-net.switching {
        opacity: 0;
        transform: translateY(6px);
        filter: blur(1px);
      }

      /* 延迟颜色 */
      #${BAR_ID} .lat-excellent { color: #16a34a; }
      #${BAR_ID} .lat-good      { color: #2563eb; }
      #${BAR_ID} .lat-mid       { color: #f59e0b; }
      #${BAR_ID} .lat-bad       { color: #ef4444; }

      @media (max-width: 600px) {
        #${BAR_ID} .ip-inner { padding: 6px 12px; }
        #${BAR_ID} .ip-text { font-size: 13px; max-width: calc(100vw - 80px); }
      }
    `);

    if (document.getElementById(BAR_ID)) return;
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.innerHTML = `
      <div class="ip-inner">
        <div class="ip-icon"></div>
        <div class="ip-text">
          <span class="ip-l">Your IP:</span>
          <span id="ip-val" title="">
            <span id="ip-base"></span>
            <span id="ip-net" class="ip-net" aria-label="点击切换测速点"></span>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(bar);
  };

  const setDisplay = (baseText, netText = '', netCls = '', probeName = '') => {
    const baseEl = document.getElementById('ip-base');
    const netEl = document.getElementById('ip-net');
    const wrapEl = document.getElementById('ip-val');
    if (!baseEl || !netEl || !wrapEl) return;

    baseEl.textContent = baseText || '';

    netEl.className = 'ip-net';
    if (netCls) netEl.classList.add(netCls);

    netEl.textContent = netText ? ` ｜ ${netText}` : '';

    if (probeName) currentProbe = probeName;

    const full = `${baseText || ''}${netText ? ` ｜ ${netText}` : ''}`.trim();
    wrapEl.setAttribute('title', full);
  };

  const animateNetSwap = async () => {
    const netEl = document.getElementById('ip-net');
    if (!netEl) return;
    isSwitching = true;
    netEl.classList.add('switching');
    await sleep(140);
  };

  const animateNetIn = async () => {
    const netEl = document.getElementById('ip-net');
    if (!netEl) return;
    requestAnimationFrame(() => {
      netEl.classList.remove('switching');
      isSwitching = false;
    });
  };

  // ====== 滚动到底部隐藏逻辑 ======
  const isNearBottom = () => {
    const doc = document.documentElement;
    const scrollTop = doc.scrollTop || document.body.scrollTop || 0;
    const viewportH = window.innerHeight || doc.clientHeight || 0;
    const scrollH = doc.scrollHeight || document.body.scrollHeight || 0;
    return (scrollH - (scrollTop + viewportH)) <= BOTTOM_HIDE_PX;
  };

  let rafPending = false;
  const updateVisibility = () => {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.toggle('ip-hidden', isNearBottom());
  };

  const onScrollOrResize = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateVisibility();
    });
  };

  const attachBottomHide = () => {
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });

    const ro = new ResizeObserver(onScrollOrResize);
    ro.observe(document.documentElement);

    updateVisibility();
  };

  const main = async () => {
    ensureBar();
    attachBottomHide();

    const GOOGLE = { name: 'Google', url: 'https://www.gstatic.com/generate_204' };
    const CF     = { name: 'CF',     url: 'https://www.cloudflare.com/cdn-cgi/trace' };

    // 点击切换：测“另一个”点并替换显示（带动画）
    const netEl = document.getElementById('ip-net');
    if (netEl) {
      netEl.addEventListener('click', async () => {
        if (!isDesktop) return;
        if (isSwitching) return;

        const want = (currentProbe === 'CF') ? GOOGLE : CF;

        await animateNetSwap();

        const baseText = document.getElementById('ip-base')?.textContent || '';
        setDisplay(baseText, '测速中…', 'lat-good', currentProbe);

        const r = await pingOnce(want, 1800);
        if (r && Number.isFinite(r.ms)) {
          const down = getDownlinkStr();
          const extra = down ? ` · ${down}` : '';
          const netText = `${r.name} 延迟 ${r.ms}ms${extra}`;
          setDisplay(baseText, netText, latencyClass(r.ms), r.name);
        } else {
          setDisplay(baseText, `${want.name} 测速失败`, 'lat-mid', currentProbe);
        }

        await sleep(30);
        await animateNetIn();
      }, { passive: true });
    }

    // 先用缓存秒显示（PC 端先显示“测速中…”占位）
    const cachedBase = loadCache();
    if (cachedBase) {
      const baseText = formatBaseText(cachedBase);
      setDisplay(baseText, isDesktop ? '测速中…' : '', '', '');
    }

    await sleep(50);

    // IP 信息接口：并发竞速
    const IPAPI_CO = 'https://ipapi.co/json/';
    const IPINFO_IO = 'https://ipinfo.hinswu.top/json';
    const IP_API_COM = 'https://ip-api.com/json/?fields=status,message,query,country,regionName,city,as,isp';

    let data = null;
    try {
      data = await fetchRaceJson([IPAPI_CO, IPINFO_IO, IP_API_COM], 4000);
    } catch {}

    if (!data) {
      if (!cachedBase) setDisplay('无法获取IP信息', '', '');
      return;
    }

    let n = normalize(data);

    // 电脑端才补全 ASN/运营商（移动端只显示地区）
    if (isDesktop && (!n.asn || !n.org)) {
      try {
        const extraRes = await fetchWithTimeout(IP_API_COM, 2500);
        const extra = await extraRes.json();
        const n2 = normalize(extra);
        if (!n.asn) n.asn = n2.asn;
        if (!n.org) n.org = n2.org;
        if (!n.loc) n.loc = n2.loc;
        if (!n.ip) n.ip = n2.ip;
      } catch {}
    }

    // 先渲染 base
    const baseText = formatBaseText(n);
    setDisplay(baseText, isDesktop ? '测速中…' : '', '', '');
    saveCache({ ip: n.ip, loc: n.loc, asn: n.asn, org: n.org });
    updateVisibility();

    // ====== PC 端：并发测 Google/CF，谁先成功显示谁（并拼上 ↓Mbps）=====
    if (isDesktop) {
      const r = await pingRace2(GOOGLE, CF, 1600);
      if (r && Number.isFinite(r.ms)) {
        const down = getDownlinkStr();
        const extra = down ? ` · ${down}` : '';
        const netText = `${r.name} 延迟 ${r.ms}ms${extra}`;
        setDisplay(baseText, netText, latencyClass(r.ms), r.name);
      } else {
        setDisplay(baseText, '测速失败', 'lat-mid', '');
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
