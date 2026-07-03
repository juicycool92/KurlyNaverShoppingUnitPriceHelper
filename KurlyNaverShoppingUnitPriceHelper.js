// ==UserScript==
// @name         Kurly Naver Shopping Unit Price Helper
// @namespace    https://shopping.naver.com/
// @version      0.6.0
// @description  Show unit and option prices from Naver Shopping API results.
// @match        https://shopping.naver.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window) return;

  var API_MARKER = "vertical-api.shopping.naver.com/v3/web/v1/kurly/search/products";
  var PANEL_ID = "tm-unit-price-debug";
  var STYLE_ID = "tm-unit-price-style";
  var STACK_CLASS = "tm-unit-price-stack";
  var ITEM_CLASS = "tm-unit-price-item";
  var STACK_ATTR = "data-tm-unit-price-stack";
  var ITEM_ATTR = "data-tm-unit-price-item";
  var CARD_ATTR = "data-tm-unit-price-card";

  var DEFAULT_BRANCH_ID = "CC02";
  var DEFAULT_SORT_TYPE = "RECOMMEND_DESC";
  var DEFAULT_DELIVERY_ATTRIBUTE_TYPE = "DAWN_ARRIVAL";

  var state = {
    apiResponses: 0,
    itemsSeen: 0,
    itemsReady: 0,
    badges: 0,
    lastMessage: "starting",
  };

  var itemIndex = new Map();
  var pendingApply = 0;
  var observer = null;
  var lastUrl = location.href;
  var navEntry = null;
  var renderedCards = new Set();
  var bootStarted = false;
  var debugEvents = [];
  var DEBUG_EVENT_LIMIT = 300;
  var DEBUG = true;

  function debugEvent(type, detail) {
    if (!DEBUG) return;

    var entry = {
      type: type,
      detail: detail,
      time: Date.now(),
    };
    debugEvents.push(entry);
    if (debugEvents.length > DEBUG_EVENT_LIMIT) {
      debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_LIMIT);
    }
  }

  function setStatus(message) {
    state.lastMessage = message;
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.textContent =
      "TM active | api " +
      state.apiResponses +
      " | items " +
      state.itemsReady +
      " | badges " +
      state.badges +
      " | " +
      message;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var host = document.head || document.documentElement;
    if (!host) return;

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "." +
      PANEL_ID +
      "{position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;border-radius:8px;background:rgba(15,23,42,.92);color:#fff;font:12px/1.4 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.24);pointer-events:none;max-width:360px}" +
      "." +
      STACK_CLASS +
      "{display:flex;flex-direction:column;gap:4px;margin-top:6px}" +
      "." +
      ITEM_CLASS +
      "{display:inline-flex;align-items:center;padding:3px 7px;border-radius:6px;background:#0f766e;color:#fff;font-size:12px;font-weight:700;line-height:1.35;letter-spacing:0;box-sizing:border-box;white-space:nowrap}" +
      "." +
      ITEM_CLASS +
      "[data-kind='volume']{background:#2563eb}" +
      "." +
      ITEM_CLASS +
      "[data-kind='weight']{background:#0f766e}" +
      "." +
      ITEM_CLASS +
      "[data-kind='raw']{background:#64748b}";
    host.appendChild(style);
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    var host = document.body || document.documentElement;
    if (!host) return;

    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.textContent = "TM active";
    host.appendChild(panel);
  }

  function clearInjectedMarkup() {
    var nodes = document.querySelectorAll(
      "[" +
        STACK_ATTR +
        '="1"],[' +
        ITEM_ATTR +
        "]"
    );
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }

    var cards = document.querySelectorAll("[" + CARD_ATTR + "]");
    for (var j = 0; j < cards.length; j += 1) {
      cards[j].removeAttribute(CARD_ATTR);
    }
  }

  function resetRuntime(reason) {
    bootStarted = false;
    itemIndex = new Map();
    renderedCards = new Set();
    state.apiResponses = 0;
    state.itemsSeen = 0;
    state.itemsReady = 0;
    state.badges = 0;
    clearTimeout(pendingApply);
    pendingApply = 0;
    clearInjectedMarkup();
    debugEvents = [];
    setStatus(reason || "reset");
  }

  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, "")
      .replace(/[^0-9a-z\uac00-\ud7a3]+/g, "");
  }

  function formatPrice(price) {
    return Number(price).toLocaleString("ko-KR");
  }

  function normalizeNumber(text) {
    return Number(String(text).replace(/,/g, "."));
  }

  function unitInfo(unit) {
    var u = String(unit || "").toLowerCase();
    if (u === "kg" || u === "kilogram") return { kind: "weight", baseUnit: "g", factor: 1000 };
    if (u === "mg" || u === "milligram") return { kind: "weight", baseUnit: "g", factor: 0.001 };
    if (u === "g" || u === "gram" || u === "grams") return { kind: "weight", baseUnit: "g", factor: 1 };
    if (u === "l" || u === "liter") return { kind: "volume", baseUnit: "ml", factor: 1000 };
    if (u === "ml" || u === "milliliter") return { kind: "volume", baseUnit: "ml", factor: 1 };
    return null;
  }

  function extractMultiplier(text, endIndex) {
    var tail = String(text || "").slice(endIndex, endIndex + 32);
    var match = tail.match(/^\s*(?:x|X|×|\*)\s*(\d{1,3})/);
    if (match) return Number(match[1]);

    match = tail.match(/^\s*(\d{1,3})\s*(?:pack|packs|set|sets|box|bottles?|cans?|개|입|팩|세트|병|캔|묶음)/i);
    if (match) return Number(match[1]);

    return 1;
  }

  function extractQuantity(name) {
    var text = String(name || "");
    var match = text.match(
      /(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l|kilogram|gram|grams|milligram|milliliter|liter)\b/i
    );
    if (!match) return null;

    var amount = normalizeNumber(match[1]);
    var info = unitInfo(match[2]);
    if (!Number.isFinite(amount) || !info) return null;

    var multiplier = extractMultiplier(text, match.index + match[0].length);
    return {
      total: amount * info.factor * multiplier,
      kind: info.kind,
      baseUnit: info.baseUnit,
      raw: match[0],
      multiplier: multiplier,
    };
  }

  function extractPrice(product) {
    var price =
      product.salePrice ??
      product.dispSalePrice ??
      (product.benefitMeta && product.benefitMeta.dispDiscountedSalePrice) ??
      (product.productAdditional && product.productAdditional.dispSalePrice) ??
      null;
    price = Number(price);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function formatUnitPrice(price, quantity) {
    var per = price / quantity.total;
    if (!Number.isFinite(per) || per <= 0) return null;
    if (per >= 100) return Math.round(per).toLocaleString("ko-KR") + "\uC6D0/" + quantity.baseUnit;
    if (per >= 10) return per.toFixed(1).replace(/\.0$/, "") + "\uC6D0/" + quantity.baseUnit;
    return per.toFixed(2).replace(/0$/, "").replace(/\.0$/, "") + "\uC6D0/" + quantity.baseUnit;
  }

  function formatItemLabel(item) {
    var priceText = formatPrice(item.price) + "\uC6D0";
    if (!item.quantity) return priceText;
    var unitText = formatUnitPrice(item.price, item.quantity);
    if (!unitText) return priceText;
    return item.quantity.raw + " " + priceText + " (" + unitText + ")";
  }

  function extractProducts(root) {
    var out = [];
    var seen = new WeakSet();

    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      if (value.productMeta && value.productMeta.name) {
        out.push(value);
      }

      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i += 1) visit(value[i]);
        return;
      }

      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key]);
      }
    }

    visit(root);
    return out;
  }

  function recordItem(name, price, sourceId, kindHint, cardId) {
    state.itemsSeen += 1;

    if (!name) return;
    price = Number(price);
    if (!Number.isFinite(price) || price <= 0) return;

    var quantity = extractQuantity(name);
    var key =
      normalizeText(name) +
      "|" +
      price +
      "|" +
      (quantity ? quantity.raw : "") +
      "|" +
      String(cardId || "");
    if (itemIndex.has(key)) {
      debugEvent("item-duplicate", {
        name: name,
        price: price,
        sourceId: sourceId,
        cardId: cardId || null,
        key: key,
      });
      return;
    }

    var item = {
      key: key,
      name: name,
      price: price,
      quantity: quantity,
      kind: quantity ? quantity.kind : kindHint || "raw",
      label: formatItemLabel({
        price: price,
        quantity: quantity,
      }),
      applied: false,
      cardId: cardId || null,
    };

    itemIndex.set(key, item);
    state.itemsReady += 1;
    debugEvent("item-recorded", {
      name: name,
      price: price,
      sourceId: sourceId,
      kind: item.kind,
      cardId: cardId || null,
      key: key,
    });
    scheduleApply();
  }

  function recordProduct(rawProduct) {
    var meta = rawProduct.productMeta || rawProduct;
    var baseName = meta.name || "";
    var basePrice = extractPrice(rawProduct);
    var cardId = rawProduct.channelProductId ? "default-" + rawProduct.channelProductId : null;
    var combos =
      (rawProduct.optionCombinations && rawProduct.optionCombinations.length && rawProduct.optionCombinations) ||
      (rawProduct.optionAdditional && rawProduct.optionAdditional.optionCombinations) ||
      [];

    debugEvent("product-recorded", {
      channelProductId: rawProduct.channelProductId || null,
      productNo: meta.productNo || null,
      cardId: cardId,
      name: baseName,
      basePrice: basePrice,
      comboCount: combos.length,
    });

    if (baseName && basePrice && !combos.length) {
      recordItem(baseName, basePrice, rawProduct.id || meta.productNo || baseName, "raw", cardId);
    }

    for (var i = 0; i < combos.length; i += 1) {
      var combo = combos[i];
      var comboName = combo.optionName2 || combo.optionName1 || baseName;
      var comboPrice = extractPrice(combo);
      var comboId = combo.id || combo.optionId || comboName;
      recordItem(comboName, comboPrice, comboId, "raw", cardId);
    }
  }

  function capturePayload(payload) {
    var products = extractProducts(payload);
    if (!products.length) return false;

    state.apiResponses += 1;
    debugEvent("payload-captured", {
      apiResponses: state.apiResponses,
      products: products.length,
    });
    for (var i = 0; i < products.length; i += 1) {
      recordProduct(products[i]);
    }
    setStatus("captured " + products.length + " products");
    return true;
  }

  function handleResponseText(text) {
    if (!text || text.indexOf('"productMeta"') === -1) return;
    try {
      var payload = JSON.parse(text);
      capturePayload(payload);
    } catch (error) {
    }
  }

  function hookFetch() {
    if (!window.fetch || window.fetch.__tmPatched) return;
    var originalFetch = window.fetch;

    function patchedFetch() {
      var args = arguments;
      var url = args[0] && typeof args[0] === "object" && "url" in args[0] ? args[0].url : String(args[0] || "");
      var promise = originalFetch.apply(this, args);

      if (url.indexOf(API_MARKER) !== -1) {
        promise
          .then(function (response) {
            try {
              response
                .clone()
                .text()
                .then(handleResponseText)
                .catch(function () {});
            } catch (error) {
            }
            return response;
          })
          .catch(function () {});
      }

      return promise;
    }

    patchedFetch.__tmPatched = true;
    window.fetch = patchedFetch;
  }

  function hookXhr() {
    var proto = XMLHttpRequest.prototype;
    if (proto.open.__tmPatched) return;

    var originalOpen = proto.open;
    var originalSend = proto.send;

    proto.open = function (method, url) {
      this.__tmUrl = url ? String(url) : "";
      return originalOpen.apply(this, arguments);
    };
    proto.open.__tmPatched = true;

    proto.send = function () {
      this.addEventListener(
        "load",
        function () {
          if (!this.__tmUrl || this.__tmUrl.indexOf(API_MARKER) === -1) return;
          try {
            handleResponseText(this.responseText || "");
          } catch (error) {
          }
        },
        { once: true }
      );
      return originalSend.apply(this, arguments);
    };
    proto.send.__tmPatched = true;
  }

  function buildSearchApiUrl() {
    var params = new URLSearchParams(location.search);
    var query = params.get("q") || "";
    var branchId = params.get("branchId") || DEFAULT_BRANCH_ID;
    var sortType = params.get("sortType") || DEFAULT_SORT_TYPE;
    var start = params.get("start") || "1";
    var display = params.get("display") || "20";
    var zipCode = params.get("zipCode") || "";
    var deliveryAttributeType = params.get("deliveryAttributeType") || DEFAULT_DELIVERY_ATTRIBUTE_TYPE;
    var filterDiscountProduct = params.get("filterDiscountProduct") || "false";

    return (
      "https://vertical-api.shopping.naver.com/v3/web/v1/kurly/search/products?" +
      "query=" +
      encodeURIComponent(query) +
      "&branchId=" +
      encodeURIComponent(branchId) +
      "&sortType=" +
      encodeURIComponent(sortType) +
      "&start=" +
      encodeURIComponent(start) +
      "&display=" +
      encodeURIComponent(display) +
      "&filterDiscountProduct=" +
      encodeURIComponent(filterDiscountProduct) +
      "&deliveryAttributeType=" +
      encodeURIComponent(deliveryAttributeType) +
      "&zipCode=" +
      encodeURIComponent(zipCode)
    );
  }

  function isBackForwardNavigation() {
    if (!navEntry) {
      var entries = performance.getEntriesByType ? performance.getEntriesByType("navigation") : [];
      navEntry = entries && entries.length ? entries[0] : null;
    }
    return navEntry && navEntry.type === "back_forward";
  }

  function findCard(item) {
    if (item.cardId) {
      var found = document.getElementById(item.cardId);
      debugEvent("card-lookup", {
        cardId: item.cardId,
        found: !!found,
      });
      if (!found) {
        state.cardsMissed = (state.cardsMissed || 0) + 1;
      } else {
        state.cardsFound = (state.cardsFound || 0) + 1;
      }
      return found;
    }
    return null;
  }

  function findTitleAnchor(card, item) {
    var wanted = normalizeText(item.name);
    var nodes = card.querySelectorAll("a,button,strong,span,div,p");
    var best = null;
    var bestScore = Infinity;

    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = normalizeText(node.textContent || "");
      if (!text) continue;
      if (text.indexOf(wanted) === -1 && wanted.indexOf(text) === -1) continue;

      var score = Math.abs(text.length - wanted.length);
      if (score < bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best;
  }

  function findStackHost(card, item) {
    function lastDivChild(node) {
      if (!node) return null;
      var children = Array.from(node.children).filter(function (el) {
        return el && el.tagName === "DIV";
      });
      return children.length ? children[children.length - 1] : null;
    }

    var level1 = lastDivChild(card);
    var level2 = lastDivChild(level1);
    var level3 = lastDivChild(level2);

    if (level3) {
      var level3Divs = Array.from(level3.children).filter(function (el) {
        return el && el.tagName === "DIV";
      });

      if (level3Divs.length >= 2) {
        return { parent: level3, beforeNode: level3Divs[1] };
      }

      if (level3Divs.length === 1) {
        return { parent: level3, beforeNode: level3Divs[0].nextElementSibling };
      }

      return { parent: level3, beforeNode: null };
    }

    var titleAnchor = findTitleAnchor(card, item);
    if (titleAnchor && titleAnchor.parentNode) {
      return { parent: titleAnchor.parentNode, beforeNode: titleAnchor.nextElementSibling };
    }

    var directDivs = Array.from(card.children).filter(function (el) {
      return el && el.tagName === "DIV";
    });
    if (directDivs.length) {
      return { parent: directDivs[directDivs.length - 1], beforeNode: null };
    }

    return { parent: card, beforeNode: null };
  }

  function ensureStack(card, item) {
    var stack = card.querySelector("[" + STACK_ATTR + '="1"]');
    if (stack) {
      debugEvent("stack-reused", {
        cardId: card.id || null,
        itemKey: item.key,
      });
      return stack;
    }

    stack = document.createElement("div");
    stack.className = STACK_CLASS;
    stack.setAttribute(STACK_ATTR, "1");

    var host = findStackHost(card, item);
    if (host.beforeNode && host.beforeNode.parentNode === host.parent) {
      host.parent.insertBefore(stack, host.beforeNode);
    } else {
      host.parent.appendChild(stack);
    }
    debugEvent("stack-created", {
      cardId: card.id || null,
      itemKey: item.key,
      hostTag: host.parent && host.parent.tagName ? host.parent.tagName : null,
      beforeTag: host.beforeNode && host.beforeNode.tagName ? host.beforeNode.tagName : null,
    });
    return stack;
  }

  function markItem(card, item) {
    if (card.querySelector("[" + ITEM_ATTR + '="' + item.key + '"]')) {
      debugEvent("row-skipped", {
        cardId: card.id || null,
        itemKey: item.key,
        reason: "already-present",
      });
      return;
    }

    var stack = ensureStack(card, item);
    var row = document.createElement("div");
    row.className = ITEM_CLASS;
    row.setAttribute(ITEM_ATTR, item.key);
    row.setAttribute("data-kind", item.kind);
    row.textContent = item.label;
    row.title = item.name;

    stack.appendChild(row);
    state.badges += 1;
    debugEvent("row-appended", {
      cardId: card.id || null,
      itemKey: item.key,
      label: item.label,
    });
  }

  function clearCardMarkup(card) {
    var stack = card.querySelector("[" + STACK_ATTR + '="1"]');
    if (stack && stack.parentNode) {
      stack.parentNode.removeChild(stack);
    }

    var items = card.querySelectorAll("[" + ITEM_ATTR + "]");
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item && item.parentNode) item.parentNode.removeChild(item);
    }
  }

  function applyBadges() {
    if (!itemIndex.size) return;

    state.applyRuns = (state.applyRuns || 0) + 1;
    debugEvent("apply-start", {
      run: state.applyRuns,
      items: itemIndex.size,
    });

    var appliedNow = 0;
    itemIndex.forEach(function (item) {
      if (item.applied) return;

      var card = findCard(item);
      if (!card) {
        debugEvent("apply-miss", {
          itemKey: item.key,
          cardId: item.cardId || null,
        });
        return;
      }

      if (!renderedCards.has(item.cardId || card.id || item.key)) {
        clearCardMarkup(card);
        renderedCards.add(item.cardId || card.id || item.key);
        debugEvent("card-cleared", {
          cardId: card.id || null,
          itemKey: item.key,
        });
      }

      markItem(card, item);
      item.applied = true;
      appliedNow += 1;
    });

    if (appliedNow) {
      setStatus("badges applied " + appliedNow);
    }
  }

  function scheduleApply() {
    window.clearTimeout(pendingApply);
    pendingApply = window.setTimeout(applyBadges, 200);
  }

  function fetchCurrentResults() {
    var url = buildSearchApiUrl() + "&_tm=" + Date.now();

    return window
      .fetch(url, { credentials: "include", cache: "no-store", redirect: "follow" })
      .then(function (response) {
        return response.text();
      })
      .then(function (text) {
        handleResponseText(text);
        scheduleApply();
      })
      .catch(function (error) {
      });
  }

  function boot() {
    if (bootStarted) return;
    bootStarted = true;

    ensureStyle();
    ensurePanel();
    if (lastUrl !== location.href || isBackForwardNavigation()) {
      lastUrl = location.href;
      resetRuntime(isBackForwardNavigation() ? "back_forward" : "url changed");
    }
    setStatus("booting");

    hookFetch();
    hookXhr();

    if (!observer) {
      observer = new MutationObserver(function () {
        scheduleApply();
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    fetchCurrentResults().finally(function () {
      scheduleApply();
      setStatus("ready");
    });
  }

  window.__TM_UNIT_PRICE_DEBUG__ = {
    get state() {
      return state;
    },
    get events() {
      return debugEvents.slice();
    },
    get items() {
      return Array.from(itemIndex.values()).map(function (item) {
        return {
          key: item.key,
          name: item.name,
          price: item.price,
          label: item.label,
          cardId: item.cardId,
          applied: item.applied,
        };
      });
    },
    dump: function () {
      return {
        state: state,
        items: Array.from(itemIndex.values()),
        events: debugEvents.slice(),
      };
    },
    inspect: function (cardId) {
      var card = document.getElementById(cardId);
      if (!card) return null;
      return {
        cardId: cardId,
        html: card.innerHTML,
        items: Array.from(card.querySelectorAll("[" + ITEM_ATTR + "]")).map(function (node) {
          return node.textContent;
        }),
      };
    },
    apply: function () {
      applyBadges();
    },
    boot: function () {
      resetRuntime("manual boot");
      boot();
    },
  };

  window.addEventListener("pageshow", function (event) {
    if (event && event.persisted) {
      resetRuntime("bfcache restore");
      boot();
    }
  });

  window.addEventListener("popstate", function () {
    window.setTimeout(function () {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        resetRuntime("popstate");
        boot();
      }
    }, 0);
  });

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
