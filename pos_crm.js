// ==========================================
// BIẾN TOÀN CỤC CHO POS, GIỎ HÀNG, CRM & HÓA ĐƠN
// ==========================================
let cart = {}; // Key: `${productId}_${unitIndex}_${isGift ? 'GIFT' : 'SALE'}`
let customers = [];
let ordersList = [];
let selectedCustomerId = "GUEST";
let currentPaymentMethod = "CASH";
let holdOrders = JSON.parse(localStorage.getItem('hh_hold_orders')) || [];
let lastParsedZaloItems = [];
let currentViewingOrder = null;
let currentLedgerCustomerId = null;


// Biến phục vụ tìm kiếm khách hàng bằng bàn phím (Keyboard-first)
let filteredPosCustomers = [];
let highlightedCustIndex = -1;

// Khởi tạo lắng nghe danh sách Khách hàng & Nhà cung cấp (CRM)
db.collection("customers").onSnapshot((snap) => {
    customers = snap.docs.map(d => {
        const data = d.data();
        // Chuẩn hóa phân loại cũ ('CUSTOMER') sang 'WHOLESALE' (Khách Sỉ) để tương thích mượt mà
        let normalizedType = data.type || "WHOLESALE";
        if (normalizedType === "CUSTOMER") normalizedType = "WHOLESALE";
        return { id: d.id, ...data, type: normalizedType };
    });
    customers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderPosCustomerSelect();
    renderCrmModule();
    if (typeof renderPoSupplierSelect === 'function') renderPoSupplierSelect();
});

window.addEventListener('load', () => {
    updateHoldBadge();
    initKeyboardShortcuts();
    initOrderDateFilter();
    initCustomerSearchOutsideClick();
    initMobileAutoHideToolbar();
    loadOverviewDashboard(); // <-- Thêm dòng này để tự động cập nhật số lượng đơn vận chuyển khi vừa mở app
});

function initOrderDateFilter() {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    
    ['ord-date-from', 'cb-date-from', 'rep-date-from'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = fmt(firstDay);
    });
    ['ord-date-to', 'cb-date-to', 'rep-date-to'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = fmt(today);
    });
}

// Phím tắt bàn phím chuẩn Sapo POS trên PC
function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F1') { e.preventDefault(); switchTab('tab-sell'); }
        else if (e.key === 'F2') {
            e.preventDefault();
            switchTab('tab-sell');
            const el = document.getElementById('sell-search-name');
            if (el) { el.focus(); el.select(); }
        }
        else if (e.key === 'F3') { e.preventDefault(); openZaloModal(); }
        else if (e.key === 'F4') {
            e.preventDefault();
            switchTab('tab-sell');
            const el = document.getElementById('pos-customer-search');
            if (el) { el.focus(); el.select(); onInputCustomerSearch(); }
        }
        else if (e.key === 'F8') { e.preventDefault(); holdCurrentOrder(); }
        else if (e.key === 'F9') { e.preventDefault(); openCheckoutModal(); }
    });
}

function removeVN(str) {
    if (!str) return '';
    return str.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// Kiểm tra khách hàng đang chọn có phải là "Khách Sỉ" hay không
function isCurrentCustomerWholesale() {
    if (selectedCustomerId === 'GUEST') return false;
    const cust = customers.find(c => c.id === selectedCustomerId);
    return cust ? (cust.type === 'WHOLESALE') : false;
}

// Lấy đơn giá chuẩn của 1 đơn vị sản phẩm theo đối tượng khách (Sỉ vs Lẻ)
function getStandardUnitPrice(product, unitIndex, isWholesale) {
    const u = product.units[unitIndex] || product.units[0];
    if (u.conversionRate === 1) {
        return isWholesale ? (Number(product.wholesalePrice) || Number(product.basePrice) || u.sellingPrice) : (Number(product.basePrice) || u.sellingPrice);
    }
    return isWholesale ? (Number(u.wholesalePrice) || Number(u.sellingPrice)) : Number(u.sellingPrice);
}

// ==========================================
// MODULE 1 (ZALO NLP): BÓC TÁCH ĐƠN ZALO TỰ ĐỘNG
// ==========================================
function openZaloModal() {
    document.getElementById('zalo-nlp-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('zalo-input-text').focus(), 100);
    previewZaloParse();
}

function closeZaloModal() {
    document.getElementById('zalo-nlp-modal').classList.add('hidden');
}

function fillSampleZaloText() {
    const sampleItems = inventory.slice(0, 3);
    if (sampleItems.length > 0) {
        const lines = sampleItems.map((item, idx) => {
            const u = item.units.length > 1 ? item.units[item.units.length - 1].unitName : item.baseUnit;
            return `${idx + 2} ${u} ${item.name}`;
        });
        document.getElementById('zalo-input-text').value = "Lấy em đơn này nhé:\n" + lines.join(", ");
    } else {
        document.getElementById('zalo-input-text').value = "Lấy em 5 thùng tiger nâu, 2 lốc bò húc\n10 gói mì hảo hảo";
    }
    previewZaloParse();
}

function parseZaloTextToItems(rawText) {
    if (!rawText || !rawText.trim()) return [];

    const segments = rawText
        .replace(/\b(voi|và|va|them|lấy|lay|cho|em|anh|chi|chị|nhé|nhe|nha|ạ|a)\b/gi, (match) => {
            const lower = removeVN(match);
            if (['voi', 'va', 'them'].includes(lower)) return ',';
            return ' ';
        })
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(s => s.length > 1);

    const commonUnits = ['thung', 'loc', 'ket', 'cay', 'day', 'bich', 'bao', 'hop', 'lon', 'chai', 'goi', 'tui', 'cai', 'ky', 'kg', 'vi'];
    const results = [];

    segments.forEach(seg => {
        let qty = 1;
        let detectedUnitHint = '';
        let productQuery = seg;

        const matchStart = seg.match(/^(\d+)\s*(x|\*)?\s*([^\d]+)$/i);
        const matchEnd = seg.match(/^([^\d]+?)\s*(?:x|\*|sl|:)?\s*(\d+)\s*([a-zA-ZÀ-ỹ]*)$/i);

        if (matchStart) {
            qty = parseInt(matchStart[1], 10) || 1;
            productQuery = matchStart[3].trim();
        } else if (matchEnd) {
            qty = parseInt(matchEnd[2], 10) || 1;
            productQuery = (matchEnd[1] + ' ' + (matchEnd[3] || '')).trim();
        }

        const words = productQuery.split(/\s+/);
        if (words.length > 1) {
            const firstWordNorm = removeVN(words[0]);
            const lastWordNorm = removeVN(words[words.length - 1]);
            if (commonUnits.includes(firstWordNorm)) {
                detectedUnitHint = firstWordNorm;
                productQuery = words.slice(1).join(' ');
            } else if (commonUnits.includes(lastWordNorm)) {
                detectedUnitHint = lastWordNorm;
                productQuery = words.slice(0, -1).join(' ');
            }
        }

        const normQuery = removeVN(productQuery);
        if (!normQuery) return;

        let bestMatch = null;
        let bestScore = 0;

        inventory.forEach(item => {
            const normName = removeVN(item.name);
            let score = 0;

            if (normName === normQuery) score = 100;
            else if (normName.includes(normQuery) || normQuery.includes(normName)) score = 80;

            item.keywords.forEach(kw => {
                const normKw = removeVN(kw);
                if (normKw === normQuery) score = Math.max(score, 95);
                else if (normQuery.includes(normKw) || normKw.includes(normQuery)) score = Math.max(score, 85);
            });

            const qWords = normQuery.split(' ').filter(w => w.length > 1);
            let matchedWords = 0;
            qWords.forEach(w => {
                if (normName.includes(w) || item.keywords.some(kw => removeVN(kw).includes(w))) {
                    matchedWords++;
                }
            });
            if (qWords.length > 0) {
                score = Math.max(score, Math.round((matchedWords / qWords.length) * 75));
            }

            if (score > bestScore && score >= 45) {
                bestScore = score;
                bestMatch = item;
            }
        });

        if (bestMatch) {
            let chosenUnitIdx = 0;
            if (detectedUnitHint) {
                const foundIdx = bestMatch.units.findIndex(u => removeVN(u.unitName) === detectedUnitHint);
                if (foundIdx !== -1) chosenUnitIdx = foundIdx;
            } else if (bestMatch.units.length > 1) {
                chosenUnitIdx = bestMatch.units.length - 1;
            }

            results.push({
                rawSegment: seg,
                matched: true,
                product: bestMatch,
                unitIndex: chosenUnitIdx,
                qty: qty
            });
        } else {
            results.push({
                rawSegment: seg,
                matched: false,
                product: null,
                unitIndex: 0,
                qty: qty
            });
        }
    });

    return results;
}

function previewZaloParse() {
    const raw = document.getElementById('zalo-input-text').value;
    const tbody = document.getElementById('zalo-preview-tbody');
    const summaryEl = document.getElementById('zalo-match-summary');

    lastParsedZaloItems = parseZaloTextToItems(raw);
    if (lastParsedZaloItems.length === 0) {
        summaryEl.innerText = "Chưa có dữ liệu";
        tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400 italic">Hãy dán tin nhắn Zalo vào ô bên trên...</td></tr>`;
        return;
    }

    const matchedCount = lastParsedZaloItems.filter(i => i.matched).length;
    summaryEl.innerText = `Nhận diện khớp ${matchedCount}/${lastParsedZaloItems.length} dòng`;
    const isWholesale = isCurrentCustomerWholesale();

    tbody.innerHTML = lastParsedZaloItems.map((row, idx) => {
        if (!row.matched) {
            return `
                <tr class="bg-red-50/60">
                    <td class="p-2 font-medium text-slate-700">"${row.rawSegment}"</td>
                    <td class="p-2 text-red-600 font-bold" colspan="3"><i class="fa-solid fa-circle-xmark mr-1"></i>Không tìm thấy tên hàng khớp trong kho</td>
                </tr>
            `;
        }
        const unitPrice = getStandardUnitPrice(row.product, row.unitIndex, isWholesale);
        const unitOptions = row.product.units.map((unitObj, uIdx) => {
            const p = getStandardUnitPrice(row.product, uIdx, isWholesale);
            return `<option value="${uIdx}" ${uIdx === row.unitIndex ? 'selected' : ''}>${unitObj.unitName} (${formatmoney(p)}đ)</option>`;
        }).join('');

        return `
            <tr class="bg-emerald-50/40">
                <td class="p-2 text-slate-500">"${row.rawSegment}"</td>
                <td class="p-2 font-bold text-slate-800"><i class="fa-solid fa-circle-check text-emerald-600 mr-1"></i>${row.product.name}</td>
                <td class="p-2 text-center">
                    <div class="flex items-center justify-center gap-1">
                        <input type="number" value="${row.qty}" min="1" onchange="lastParsedZaloItems[${idx}].qty = parseInt(this.value)||1; previewZaloParse();" class="w-12 border rounded p-1 text-center font-bold">
                        <select onchange="lastParsedZaloItems[${idx}].unitIndex = parseInt(this.value); previewZaloParse();" class="border rounded p-1 text-xs font-bold bg-white text-inni-blue">
                            ${unitOptions}
                        </select>
                    </div>
                </td>
                <td class="p-2 text-right font-bold text-red-600">${formatmoney(unitPrice * row.qty)} đ</td>
            </tr>
        `;
    }).join('');
}

function pushZaloItemsToCart() {
    const validItems = lastParsedZaloItems.filter(i => i.matched && i.product);
    if (validItems.length === 0) {
        return alert("Chưa có mặt hàng nào khớp để thêm vào giỏ!");
    }

    validItems.forEach(row => {
        addToCartWithUnit(row.product.id, row.unitIndex, row.qty, false);
    });

    document.getElementById('zalo-input-text').value = '';
    closeZaloModal();
    playBeepSound();
}

// ==========================================
// MODULE 2: GIAO DIỆN POS BÁN SỈ, TÌM KIẾM KEYBOARD-FIRST & GIỎ HÀNG
// ==========================================
function handlePosSearchEnter(e) {
    if (e.key !== 'Enter') return;
    const query = e.target.value.trim();
    if (!query) return;

    // 1. Ưu tiên khớp chính xác Mã vạch trước (Súng bắn mã vạch)
    if (tryAddByBarcode(query)) {
        e.target.value = '';
        renderSellGrid();
        return;
    }

    // 2. Nếu gõ text nhanh + Enter: Tự động chọn mặt hàng khớp đầu tiên đang hiển thị
    const normSearch = removeVN(query);
    const matchedProd = inventory.find(item => 
        item.stock > 0 && (
            removeVN(item.name).includes(normSearch) || 
            item.keywords.some(k => removeVN(k).includes(normSearch))
        )
    );
    if (matchedProd) {
        // Nếu khách sỉ và sản phẩm có đơn vị Thùng, có thể thêm đơn vị mặc định
        addToCartWithUnit(matchedProd.id, 0, 1, false);
        playBeepSound();
        e.target.value = '';
        renderSellGrid();
    }
}

function startPosBarcodeScanner() {
    startBarcodeScanner(null, (decodedCode) => {
        if (!tryAddByBarcode(decodedCode)) {
            alert(`Không tìm thấy sản phẩm nào có mã vạch: ${decodedCode}`);
        }
    });
}

function tryAddByBarcode(code) {
    const cleanCode = code.trim().toLowerCase();
    for (const item of inventory) {
        for (let uIdx = 0; uIdx < item.units.length; uIdx++) {
            const u = item.units[uIdx];
            if (u.barcode && u.barcode.toLowerCase() === cleanCode) {
                addToCartWithUnit(item.id, uIdx, 1, false);
                playBeepSound();
                return true;
            }
        }
        if (item.barcode && item.barcode.toLowerCase() === cleanCode) {
            addToCartWithUnit(item.id, 0, 1, false);
            playBeepSound();
            return true;
        }
    }
    return false;
}

let posSearchDebounceTimer = null;
let currentActivePosTierWholesale = false;
let showPosCostGlobal = false; // Mặc định ẩn giá vốn để tránh lộ khi khách đứng cạnh
let revealedCartCostKeys = {}; // Lưu các món được chạm vào tên để xem nhanh giá vốn

function togglePosCostVisibility() {
    showPosCostGlobal = !showPosCostGlobal;
    if (!showPosCostGlobal) revealedCartCostKeys = {};

    const btn = document.getElementById('btn-toggle-pos-cost');
    const icon = document.getElementById('icon-toggle-pos-cost');
    if (btn && icon) {
        if (showPosCostGlobal) {
            btn.className = "px-2 py-0.5 rounded-md border border-blue-300 bg-blue-50 text-[#0088FF] text-[10px] font-bold flex items-center gap-1 normal-case transition scale-active";
            icon.className = "fa-solid fa-eye";
        } else {
            btn.className = "px-2 py-0.5 rounded-md border border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200 text-[10px] font-bold flex items-center gap-1 normal-case transition scale-active";
            icon.className = "fa-solid fa-eye-slash";
        }
    }
    renderSellGrid();
}

function toggleSingleCartItemCost(cartKey) {
    if (showPosCostGlobal) return; // Nếu đang bật con mắt toàn cục thì luôn hiện
    revealedCartCostKeys[cartKey] = !revealedCartCostKeys[cartKey];
    const el = document.getElementById(`cart-cost-info-${cartKey}`);
    if (el) el.classList.toggle('hidden', !revealedCartCostKeys[cartKey]);
}

function getCartItemUnitCost(cItem) {
    const prod = inventory.find(i => i.id === cItem.productId);
    const baseCost = prod ? (Number(prod.costPrice) || 0) : (Number(cItem.costPricePerBase) || 0);
    return Math.round(baseCost * (Number(cItem.conversionRate) || 1));
}

function onPosSearchInput() {
    const inp = document.getElementById('sell-search-name');
    const clearBtn = document.getElementById('btn-clear-pos-search');
    const val = (inp?.value || '').trim();
    if (clearBtn) clearBtn.classList.toggle('hidden', !val);

    if (window.innerWidth < 768) {
        if (val.length > 0) openMobileProductSelector();
        else closeMobileProductSelector();
    }

    clearTimeout(posSearchDebounceTimer);
    posSearchDebounceTimer = setTimeout(() => {
        renderSellGrid();
    }, 180);
}

function clearPosSearchInput() {
    const inp = document.getElementById('sell-search-name');
    if (inp) inp.value = '';
    document.getElementById('btn-clear-pos-search')?.classList.add('hidden');
    closeMobileProductSelector();
    renderSellGrid();
}

function openMobileProductSelector() {
    const wrapper = document.getElementById('pos-product-grid-wrapper');
    if (wrapper) {
        wrapper.classList.add('mobile-picker-open');
        renderSellGrid();
    }
}

function closeMobileProductSelector() {
    const wrapper = document.getElementById('pos-product-grid-wrapper');
    if (wrapper) wrapper.classList.remove('mobile-picker-open');
}

function renderSellGrid() {
    const grid = document.getElementById('sell-grid');
    const noResult = document.getElementById('sell-no-result');
    if (!grid) return;
    grid.innerHTML = '';

    const rawSearch = (document.getElementById('sell-search-name')?.value || '').trim();
    const normSearch = removeVN(rawSearch);
    const filterCat = document.getElementById('sell-search-cat')?.value || 'all';
    const isWholesaleCust = currentActivePosTierWholesale;
    let count = 0;

    for (let i = 0; i < inventory.length; i++) {
        const item = inventory[i];
        if (filterCat !== 'all' && item.category !== filterCat) continue;
        if (normSearch) {
            const matchName = removeVN(item.name).includes(normSearch);
            const matchKw = item.keywords.some(k => removeVN(k).includes(normSearch));
            const matchBc = (item.barcode && item.barcode.includes(rawSearch)) || item.units.some(u => u.barcode && u.barcode.includes(rawSearch));
            if (!matchName && !matchKw && !matchBc) continue;
        }
        count++;
        if (count > 60) continue; // Giới hạn DOM tối đa 60 thẻ trên màn hình POS để cuộn mượt

        const isOut = item.stock <= 0;
        const isLow = item.stock > 0 && item.stock <= item.minStock;

        const imgTag = item.image 
            ? `<div class="w-full h-16 md:h-20 bg-white rounded-lg mb-1.5 border border-slate-100 flex items-center justify-center overflow-hidden relative">
                    <img src="${item.image}" class="max-w-full max-h-full object-contain">
                    <span class="absolute top-1 right-1 text-[10px] font-bold px-1.5 py-0.2 rounded ${isOut ? 'bg-red-600 text-white' : (isLow ? 'bg-amber-500 text-white' : 'bg-emerald-100 text-emerald-800')}">
                        ${isOut ? 'Hết' : `Tồn: ${item.stock}`}
                    </span>
               </div>`
            : `<div class="w-full h-16 md:h-20 bg-slate-50 rounded-lg mb-1.5 flex items-center justify-center text-slate-300 border border-slate-100 relative">
                    <i class="fa-solid fa-box text-xl"></i>
                    <span class="absolute top-1 right-1 text-[10px] font-bold px-1.5 py-0.2 rounded ${isOut ? 'bg-red-600 text-white' : (isLow ? 'bg-amber-500 text-white' : 'bg-emerald-100 text-emerald-800')}">
                        ${isOut ? 'Hết' : `Tồn: ${item.stock}`}
                    </span>
               </div>`;

        const unitButtonsHtml = item.units.map((u, uIdx) => {
            const isBigUnit = u.conversionRate > 1;
            const displayPrice = getStandardUnitPrice(item, uIdx, isWholesaleCust);
            const unitCost = Math.round((Number(item.costPrice) || 0) * (Number(u.conversionRate) || 1));
            const costSubText = showPosCostGlobal
                ? `<div class="text-[9.5px] ${isBigUnit ? 'text-blue-100' : 'text-slate-500'} font-normal text-left leading-tight mt-0.5">Vốn: ${formatmoney(unitCost)}đ/${u.unitName}</div>`
                : '';
            const btnStyle = isBigUnit 
                ? 'bg-[#0088FF] hover:bg-blue-700 text-white font-bold shadow-sm' 
                : 'bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold border border-slate-200';
            return `
                <button onclick="addToCartWithUnit('${item.id}', ${uIdx}, 1, false)" class="w-full py-1.5 px-2 rounded-lg text-[11px] flex flex-col items-stretch transition scale-active ${btnStyle}">
                    <div class="flex justify-between items-center w-full">
                        <span class="truncate">+1 ${u.unitName}${isBigUnit ? ` (${u.conversionRate})` : ''}</span>
                        <span class="${isBigUnit ? 'text-amber-200 font-black' : 'text-red-600 font-bold'} ml-1">${formatmoney(displayPrice)}đ</span>
                    </div>
                    ${costSubText}
                </button>
            `;
        }).join('');

        grid.innerHTML += `
            <div id="pos-card-${item.id}" class="bg-white border border-slate-200 rounded-xl p-2 shadow-sm flex flex-col justify-between hover:border-inni-blue transition ${isOut ? 'opacity-50 pointer-events-none' : ''}">
                <div>
                    ${imgTag}
                    <div class="font-bold text-slate-800 text-xs line-clamp-2 leading-snug h-8 mb-1.5" title="${item.name}">${item.name}</div>
                </div>
                <div class="space-y-1 mt-auto">
                    ${unitButtonsHtml}
                </div>
            </div>
        `;
    }

    if (count === 0) noResult.classList.remove('hidden');
    else noResult.classList.add('hidden');

    renderCart();
}

function getTotalBaseQtyInCart(productId, excludeKey = null) {
    let totalBase = 0;
    for (const key in cart) {
        if (key === excludeKey) continue;
        if (cart[key].productId === productId) {
            totalBase += cart[key].qty * cart[key].conversionRate;
        }
    }
    return totalBase;
}

function addToCartWithUnit(productId, unitIndex = 0, addQty = 1, isGift = false, forcedCustomPrice = null) {
    const item = inventory.find(i => i.id === productId);
    if (!item) return;

    const u = item.units[unitIndex] || item.units[0];
    const cartKey = `${productId}_${unitIndex}_${isGift ? 'GIFT' : 'SALE'}`;

    const neededBaseQty = addQty * u.conversionRate;
    const currentBaseInCart = getTotalBaseQtyInCart(productId);

    if (currentBaseInCart + neededBaseQty > item.stock) {
        return alert(`Không đủ tồn kho cho "${item.name}"!\n- Tồn kho hiện tại: ${item.stock} ${item.baseUnit}\n- Trong giỏ đã có: ${currentBaseInCart} ${item.baseUnit}`);
    }

    if (!cart[cartKey]) {
        const tierPrice = getStandardUnitPrice(item, unitIndex, currentActivePosTierWholesale);
        const initialPrice = isGift ? 0 : (forcedCustomPrice !== null ? forcedCustomPrice : tierPrice);

        cart[cartKey] = {
            cartKey,
            productId: item.id,
            name: item.name,
            baseUnit: item.baseUnit,
            unitIndex: unitIndex,
            unitName: u.unitName,
            conversionRate: u.conversionRate,
            price: initialPrice,
            originalPrice: tierPrice,
            costPricePerBase: item.costPrice,
            qty: 0,
            isGift: isGift,
            manualPriceEdited: forcedCustomPrice !== null
        };
    }

    cart[cartKey].qty += addQty;

    // Trên Mobile: Sau khi chọn sản phẩm xong -> Tự động đóng danh sách chọn hàng và trở về giao diện giỏ hàng
    if (window.innerWidth < 768) {
        closeMobileProductSelector();
        const sInp = document.getElementById('sell-search-name');
        if (sInp) sInp.value = '';
        document.getElementById('btn-clear-pos-search')?.classList.add('hidden');
    }

    renderCart();
}

function applyTierPriceToAllCart(useWholesalePrice, forceResetManual = false) {
    currentActivePosTierWholesale = !!useWholesalePrice;
    for (const key in cart) {
        const cItem = cart[key];
        if (cItem.isGift) continue;
        if (cItem.manualPriceEdited && !forceResetManual) continue;
        const prod = inventory.find(i => i.id === cItem.productId);
        if (prod) {
            cItem.price = getStandardUnitPrice(prod, cItem.unitIndex, useWholesalePrice);
            cItem.originalPrice = cItem.price;
            cItem.manualPriceEdited = false;
        }
    }

    const btnRet = document.getElementById('btn-tier-retail');
    const btnWho = document.getElementById('btn-tier-wholesale');
    if (btnRet && btnWho) {
        if (useWholesalePrice) {
            btnWho.className = "px-3 py-1 rounded-md text-[11px] font-bold bg-[#0088FF] text-white shadow-sm transition";
            btnRet.className = "px-3 py-1 rounded-md text-[11px] font-bold text-slate-600 hover:text-slate-800 transition";
        } else {
            btnRet.className = "px-3 py-1 rounded-md text-[11px] font-bold bg-[#0088FF] text-white shadow-sm transition";
            btnWho.className = "px-3 py-1 rounded-md text-[11px] font-bold text-slate-600 hover:text-slate-800 transition";
        }
    }
    renderCart();
}

function changeCartItemUnit(oldKey, newUnitIndex) {
    const cItem = cart[oldKey];
    if (!cItem) return;
    const prod = inventory.find(i => i.id === cItem.productId);
    if (!prod || !prod.units[newUnitIndex]) return;

    const newUnit = prod.units[newUnitIndex];
    const otherBaseQty = getTotalBaseQtyInCart(cItem.productId, oldKey);

    if (otherBaseQty + (cItem.qty * newUnit.conversionRate) > prod.stock) {
        alert(`Kho chỉ còn ${prod.stock} ${prod.baseUnit}, không đủ để đổi sang ${cItem.qty} ${newUnit.unitName}!`);
        renderCart();
        return;
    }

    const newKey = `${cItem.productId}_${newUnitIndex}_${cItem.isGift ? 'GIFT' : 'SALE'}`;
    const newPrice = cItem.isGift ? 0 : getStandardUnitPrice(prod, newUnitIndex, currentActivePosTierWholesale);

    delete cart[oldKey];
    if (cart[newKey]) {
        cart[newKey].qty += cItem.qty;
    } else {
        cart[newKey] = {
            ...cItem,
            cartKey: newKey,
            unitIndex: newUnitIndex,
            unitName: newUnit.unitName,
            conversionRate: newUnit.conversionRate,
            price: newPrice,
            originalPrice: newPrice,
            manualPriceEdited: false
        };
    }
    renderCart();
}

function updateCartQty(cartKey, delta, exactVal = null) {
    const cItem = cart[cartKey];
    if (!cItem) return;
    const prod = inventory.find(i => i.id === cItem.productId);
    const maxStock = prod ? prod.stock : 999999;

    const newQty = exactVal !== null ? (parseInt(exactVal, 10) || 0) : (cItem.qty + delta);
    if (newQty <= 0) {
        delete cart[cartKey];
        renderCart();
        return;
    }

    const otherBase = getTotalBaseQtyInCart(cItem.productId, cartKey);
    if (otherBase + (newQty * cItem.conversionRate) > maxStock) {
        alert(`Vượt quá tồn kho! Kho chỉ còn tối đa ${maxStock} ${cItem.baseUnit}.`);
        renderCart();
        return;
    }

    cItem.qty = newQty;
    renderCart();
}

function updateCartCustomPrice(cartKey, inputEl) {
    const cItem = cart[cartKey];
    if (!cItem) return;
    formatCurrencyInput(inputEl);
    const newPrice = getRawNum(inputEl);
    cItem.price = newPrice;
    cItem.isGift = (newPrice === 0);
    cItem.manualPriceEdited = true;
    updateCartTotalsOnly();
}

function toggleCartItemGift(cartKey) {
    const cItem = cart[cartKey];
    if (!cItem) return;

    if (!cItem.isGift) {
        cItem.originalPrice = cItem.price > 0 ? cItem.price : cItem.originalPrice;
        cItem.price = 0;
        cItem.isGift = true;
    } else {
        cItem.price = cItem.originalPrice || 0;
        cItem.isGift = false;
    }
    renderCart();
}

function clearCart() {
    if (Object.keys(cart).length === 0) return;
    if (confirm("Làm trống giỏ hàng hiện tại?")) {
        cart = {};
        renderCart();
    }
}

function renderCart() {
    const list = document.getElementById('cart-list');
    const countEl = document.getElementById('cart-item-count');
    const botCntEl = document.getElementById('cart-bottom-count');
    if (!list) return;
    list.innerHTML = '';

    const keys = Object.keys(cart);
    if (countEl) countEl.innerText = keys.length;
    if (botCntEl) botCntEl.innerText = keys.length;

    if (keys.length === 0) {
        list.innerHTML = `
            <li class="text-center py-10 flex flex-col items-center justify-center gap-2.5">
                <div class="w-11 h-11 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-lg">
                    <i class="fa-solid fa-basket-shopping"></i>
                </div>
                <div class="text-slate-400 text-xs">Đơn hàng chưa có sản phẩm nào</div>
                <button type="button" onclick="openMobileProductSelector(); document.getElementById('sell-search-name').focus();" class="bg-blue-50 text-[#0088FF] border border-blue-200 px-4 py-1.5 rounded-lg font-bold text-xs scale-active">
                    Chọn sản phẩm
                </button>
            </li>`;
        updateCartTotalsOnly();
        return;
    }

    keys.forEach(key => {
        const item = cart[key];
        const prod = inventory.find(i => i.id === item.productId);
        const units = prod ? prod.units : [{ unitName: item.unitName, conversionRate: item.conversionRate }];

        const unitSelectHtml = units.map((u, idx) => 
            `<option value="${idx}" ${idx === item.unitIndex ? 'selected' : ''}>${u.unitName}${u.conversionRate > 1 ? ` (${u.conversionRate}${item.baseUnit})` : ''}</option>`
        ).join('');

        const lineTotal = item.price * item.qty;
        const giftBadge = item.isGift 
            ? `<span class="bg-purple-600 text-white text-[10px] px-1.5 py-0.2 rounded font-bold ml-1">TẶNG 0Đ</span>` 
            : '';

        // Quy đổi Giá vốn & Lãi theo đúng ĐVT đang chọn (VD: Thùng = Giá vốn Lon x 24)
        const unitCost = getCartItemUnitCost(item);
        const unitProfit = (Number(item.price) || 0) - unitCost;
        const isCostVisible = showPosCostGlobal || !!revealedCartCostKeys[key];
        const isBelowCost = (!item.isGift || item.manualPriceEdited) && unitCost > 0 && item.price < unitCost;

        list.innerHTML += `
            <li class="p-2.5 rounded-xl border ${item.isGift ? 'bg-purple-50/60 border-purple-300' : 'bg-white border-slate-200'} flex flex-col gap-2 shadow-sm">
                <div class="flex justify-between items-start gap-2">
                    <div onclick="toggleSingleCartItemCost('${key}')" class="font-bold text-slate-800 text-xs leading-snug flex-1 cursor-pointer select-none" title="Chạm vào tên món để xem/ẩn nhanh giá vốn">
                        <div>${item.name} ${giftBadge}</div>
                        <div id="cart-cost-info-${key}" class="${isCostVisible ? '' : 'hidden'} text-[11px] font-semibold text-slate-500 mt-0.5">
                            Vốn: <b class="text-slate-700">${formatmoney(unitCost)}đ</b> | Lãi: <b class="${unitProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}">${unitProfit >= 0 ? '+' : ''}${formatmoney(unitProfit)}đ/${item.unitName}</b>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button onclick="toggleCartItemGift('${key}')" class="text-[10px] font-bold px-2 py-0.5 rounded border ${item.isGift ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-purple-700 border-purple-300'}">
                            Tặng 0đ
                        </button>
                        <button onclick="updateCartQty('${key}', -99999)" class="text-slate-400 hover:text-red-500 px-1"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div class="grid grid-cols-12 gap-1.5 items-start">
                    <div class="col-span-4">
                        <select onchange="changeCartItemUnit('${key}', parseInt(this.value))" class="w-full border border-slate-300 rounded-lg p-1 text-xs font-bold bg-white text-inni-blue focus:outline-none">
                            ${unitSelectHtml}
                        </select>
                    </div>
                    <div class="col-span-4">
                        <div class="relative">
                            <input type="text" value="${formatmoney(item.price)}" oninput="updateCartCustomPrice('${key}', this)" class="w-full border border-amber-400 bg-amber-50/50 focus:bg-white rounded-lg p-1 pr-4 text-xs font-black text-red-600 text-right focus:outline-none">
                            <i class="fa-solid fa-pen text-[8px] text-amber-500 absolute right-1.5 top-2 pointer-events-none"></i>
                        </div>
                        <div id="below-cost-warn-${key}" class="${isBelowCost ? '' : 'hidden'} text-[10px] font-bold text-red-600 mt-0.5 leading-tight text-right">
                            ⚠️ Thấp hơn giá vốn!
                        </div>
                    </div>
                    <div class="col-span-4 flex items-center justify-end gap-1">
                        <button onclick="updateCartQty('${key}', -1)" class="w-6 h-6 bg-white border border-slate-300 rounded flex items-center justify-center text-slate-600"><i class="fa-solid fa-minus text-[9px]"></i></button>
                        <input type="number" value="${item.qty}" onchange="updateCartQty('${key}', 0, this.value)" class="w-10 border border-slate-300 rounded p-0.5 text-center font-black text-xs text-slate-800 bg-white">
                        <button onclick="updateCartQty('${key}', 1)" class="w-6 h-6 bg-white border border-slate-300 rounded flex items-center justify-center text-slate-600"><i class="fa-solid fa-plus text-[9px]"></i></button>
                    </div>
                </div>

                <div class="flex justify-between items-center text-[11px] pt-1 border-t border-slate-100">
                    <span class="text-slate-400">Thành tiền:</span>
                    <span class="font-black text-slate-800 text-xs" id="line-total-${key}">${formatmoney(lineTotal)} đ</span>
                </div>
            </li>
        `;
    });

    updateCartTotalsOnly();
}

function updateCartTotalsOnly() {
    let subtotal = 0;
    for (const key in cart) {
        const item = cart[key];
        const lineTotal = item.price * item.qty;
        subtotal += lineTotal;
        const lineEl = document.getElementById(`line-total-${key}`);
        if (lineEl) lineEl.innerText = `${formatmoney(lineTotal)} đ`;

        // Cập nhật tức thời dòng Giá vốn | Lãi và Cảnh báo bán lỗ khi đang gõ sửa giá
        const unitCost = getCartItemUnitCost(item);
        const unitProfit = (Number(item.price) || 0) - unitCost;
        const costInfoEl = document.getElementById(`cart-cost-info-${key}`);
        if (costInfoEl) {
            costInfoEl.innerHTML = `Vốn: <b class="text-slate-700">${formatmoney(unitCost)}đ</b> | Lãi: <b class="${unitProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}">${unitProfit >= 0 ? '+' : ''}${formatmoney(unitProfit)}đ/${item.unitName}</b>`;
        }
        const warnEl = document.getElementById(`below-cost-warn-${key}`);
        if (warnEl) {
            const isBelowCost = (!item.isGift || item.manualPriceEdited) && unitCost > 0 && item.price < unitCost;
            warnEl.classList.toggle('hidden', !isBelowCost);
        }
    }

    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;

    document.getElementById('cart-subtotal').innerText = `${formatmoney(subtotal)} đ`;
    const oldDebtRow = document.getElementById('cart-old-debt-row');
    if (oldDebt > 0) {
        oldDebtRow.classList.remove('hidden');
        document.getElementById('cart-old-debt').innerText = `${formatmoney(oldDebt)} đ`;
    } else {
        oldDebtRow.classList.add('hidden');
    }

    document.getElementById('cart-total').innerText = `${formatmoney(subtotal)} đ`;
}

function togglePosCustomerSearchBox() {
    const wrap = document.getElementById('pos-customer-search-wrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) {
        const inp = document.getElementById('pos-customer-search');
        if (inp) {
            inp.value = '';
            inp.focus();
            onInputCustomerSearch();
        }
    }
}

function togglePosNoteInput() {
    const wrap = document.getElementById('pos-note-input-wrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) {
        document.getElementById('seller-name')?.focus();
    }
}

function syncPosNoteSummary() {
    const val = document.getElementById('seller-name')?.value.trim() || '';
    const sumEl = document.getElementById('pos-note-summary');
    if (sumEl) {
        sumEl.innerHTML = val ? `<b class="text-slate-700 not-italic">${val}</b> <i class="fa-solid fa-pen text-[10px] ml-1"></i>` : `Thêm ghi chú... <i class="fa-solid fa-pen text-[10px] ml-1"></i>`;
    }
}

function initCustomerSearchOutsideClick() {
    document.addEventListener('click', (e) => {
        const drop = document.getElementById('pos-customer-dropdown');
        const inp = document.getElementById('pos-customer-search');
        if (drop && inp && !drop.contains(e.target) && e.target !== inp) {
            drop.classList.add('hidden');
        }
    });
}

function renderPosCustomerSelect() {
    const sel = document.getElementById('pos-customer-select');
    if (!sel) return;
    sel.innerHTML = `<option value="GUEST">Khách lẻ</option>`;
    customers.filter(c => c.type !== 'SUPPLIER').forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.name} - ${c.phone || ''}</option>`;
    });
    sel.value = customers.some(c => c.id === selectedCustomerId) ? selectedCustomerId : 'GUEST';
    syncCustomerSearchDisplay();
}

function syncCustomerSearchDisplay() {
    const inp = document.getElementById('pos-customer-search');
    const dispName = document.getElementById('pos-customer-display-name');
    const debtBadge = document.getElementById('pos-customer-debt-badge');
    const resetBtn = document.getElementById('btn-reset-guest-inline');

    if (selectedCustomerId === 'GUEST') {
        if (inp) inp.value = "";
        if (dispName) dispName.innerText = "Khách lẻ";
        if (debtBadge) debtBadge.classList.add('hidden');
        if (resetBtn) resetBtn.classList.add('hidden');
    } else {
        const cust = customers.find(c => c.id === selectedCustomerId);
        if (cust) {
            const label = `${cust.name}${cust.phone ? ` (${cust.phone})` : ''}`;
            if (inp) inp.value = label;
            if (dispName) dispName.innerText = label;
            if (resetBtn) resetBtn.classList.remove('hidden');
            if (debtBadge) {
                if (cust.currentDebt > 0) {
                    debtBadge.innerText = `(Nợ: ${formatmoney(cust.currentDebt)}đ)`;
                    debtBadge.classList.remove('hidden');
                } else {
                    debtBadge.classList.add('hidden');
                }
            }
        }
    }
}

function onInputCustomerSearch() {
    const inp = document.getElementById('pos-customer-search');
    const drop = document.getElementById('pos-customer-dropdown');
    if (!inp || !drop) return;

    const raw = inp.value.trim();
    const norm = removeVN(raw);

    const buyerList = customers.filter(c => c.type !== 'SUPPLIER');
    filteredPosCustomers = [
        { id: 'GUEST', name: 'Khách lẻ', phone: '', type: 'RETAIL', currentDebt: 0 },
        ...buyerList.filter(c => {
            if (!norm) return true;
            return removeVN(c.name).includes(norm) || 
                   (c.phone && c.phone.includes(raw)) || 
                   (c.customerCode && removeVN(c.customerCode).includes(norm));
        })
    ].slice(0, 20);

    highlightedCustIndex = 0;
    renderCustomerDropdownList();
    drop.classList.remove('hidden');
}

function renderCustomerDropdownList() {
    const drop = document.getElementById('pos-customer-dropdown');
    if (!drop) return;

    drop.innerHTML = filteredPosCustomers.map((c, idx) => {
        const isHighlighted = idx === highlightedCustIndex;
        const isWholesale = c.type === 'WHOLESALE';
        const badge = c.id === 'GUEST' 
            ? `<span class="text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded">Mặc định</span>`
            : (isWholesale 
                ? `<span class="text-[10px] bg-blue-100 text-inni-blue font-bold px-1.5 py-0.2 rounded">Khách Sỉ</span>` 
                : `<span class="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded">Khách Lẻ</span>`);
        const debtHtml = c.currentDebt > 0 ? `<span class="text-[10px] text-red-600 font-bold ml-1">Nợ: ${formatmoney(c.currentDebt)}đ</span>` : '';

        return `
            <div onclick="selectPosCustomerFromDropdown('${c.id}')" class="p-2.5 cursor-pointer flex justify-between items-center transition ${isHighlighted ? 'bg-blue-100 font-bold' : 'hover:bg-slate-50'}">
                <div>
                    <div class="text-slate-800">${c.name} ${c.phone ? `<span class="text-slate-500 font-normal">(${c.phone})</span>` : ''}</div>
                    ${debtHtml}
                </div>
                <div>${badge}</div>
            </div>
        `;
    }).join('');
}

function handleCustomerSearchKeydown(e) {
    const drop = document.getElementById('pos-customer-dropdown');
    if (!drop || drop.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightedCustIndex = Math.min(filteredPosCustomers.length - 1, highlightedCustIndex + 1);
        renderCustomerDropdownList();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightedCustIndex = Math.max(0, highlightedCustIndex - 1);
        renderCustomerDropdownList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredPosCustomers[highlightedCustIndex]) {
            selectPosCustomerFromDropdown(filteredPosCustomers[highlightedCustIndex].id);
        }
    } else if (e.key === 'Escape') {
        drop.classList.add('hidden');
        syncCustomerSearchDisplay();
    }
}

function selectPosCustomerFromDropdown(custId) {
    selectedCustomerId = custId || 'GUEST';
    const sel = document.getElementById('pos-customer-select');
    if (sel) sel.value = selectedCustomerId;
    document.getElementById('pos-customer-dropdown')?.classList.add('hidden');
    document.getElementById('pos-customer-search-wrap')?.classList.add('hidden');

    syncCustomerSearchDisplay();
    const isWholesale = isCurrentCustomerWholesale();
    applyTierPriceToAllCart(isWholesale);
    renderSellGrid();
}

function resetToGuestCustomer() {
    selectPosCustomerFromDropdown('GUEST');
}

function onSelectPosCustomer() {
    const sel = document.getElementById('pos-customer-select');
    selectPosCustomerFromDropdown(sel ? sel.value : 'GUEST');
}

async function quickAddCustomerPrompt() {
    openCustomerModal(null);
}

// ==========================================
// CẤT ĐƠN / LƯU TẠM ĐƠN HÀNG (PARK ORDER - F8)
// ==========================================
function updateHoldBadge() {
    const badge = document.getElementById('hold-count-badge');
    if (badge) badge.innerText = holdOrders.length;
}

function holdCurrentOrder() {
    if (Object.keys(cart).length === 0) return alert("Giỏ hàng đang trống, không có gì để cất đơn!");
    const note = prompt("Ghi chú đơn cất tạm (VD: Anh Ba chờ lấy thêm bia):", "Khách đang lựa thêm");
    if (note === null) return;

    const cust = customers.find(c => c.id === selectedCustomerId);
    holdOrders.unshift({
        holdId: "HOLD-" + Date.now(),
        customerId: selectedCustomerId,
        customerName: cust ? cust.name : "Khách Lẻ",
        note: note.trim() || "Đơn lưu tạm",
        cartData: JSON.parse(JSON.stringify(cart)),
        savedAt: Date.now()
    });

    localStorage.setItem('hh_hold_orders', JSON.stringify(holdOrders));
    cart = {};
    selectPosCustomerFromDropdown("GUEST");
    renderCart();
    updateHoldBadge();
}

function openHoldOrdersModal() {
    const list = document.getElementById('hold-orders-list');
    list.innerHTML = '';

    if (holdOrders.length === 0) {
        list.innerHTML = `<div class="text-center p-8 text-slate-400 italic text-sm">Chưa có đơn hàng nào đang cất tạm.</div>`;
    } else {
        holdOrders.forEach((h, idx) => {
            const timeStr = new Date(h.savedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
            const itemsSummary = Object.values(h.cartData).map(i => `${i.name} (${i.qty} ${i.unitName})`).join(', ');
            let total = 0;
            Object.values(h.cartData).forEach(i => total += i.price * i.qty);

            list.innerHTML += `
                <div class="p-3 rounded-xl border border-amber-200 bg-amber-50/40 flex justify-between items-center gap-3">
                    <div class="flex-1 overflow-hidden">
                        <div class="font-bold text-slate-800 text-sm">${h.customerName} <span class="text-xs text-amber-700 font-semibold">(${h.note})</span></div>
                        <div class="text-xs text-slate-500 truncate mt-0.5">${itemsSummary}</div>
                        <div class="text-xs font-black text-red-600 mt-1">Lúc ${timeStr} • Tổng: ${formatmoney(total)} đ</div>
                    </div>
                    <div class="flex gap-1.5 shrink-0">
                        <button onclick="restoreHoldOrder(${idx})" class="bg-inni-blue text-white text-xs font-bold px-3 py-2 rounded-lg shadow-sm scale-active">
                            Mở Lại Đơn
                        </button>
                        <button onclick="deleteHoldOrder(${idx})" class="bg-red-100 text-red-600 px-2.5 py-2 rounded-lg text-xs font-bold">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;
        });
    }
    document.getElementById('hold-orders-modal').classList.remove('hidden');
}

function closeHoldOrdersModal() {
    document.getElementById('hold-orders-modal').classList.add('hidden');
}

function restoreHoldOrder(idx) {
    if (Object.keys(cart).length > 0) {
        if (!confirm("Giỏ hàng hiện tại đang có đồ. Mở lại đơn cất tạm sẽ ghi đè giỏ hàng hiện tại. Tiếp tục?")) return;
    }
    const h = holdOrders[idx];
    if (!h) return;

    selectedCustomerId = h.customerId || "GUEST";
    syncCustomerSearchDisplay();
    cart = h.cartData;

    holdOrders.splice(idx, 1);
    localStorage.setItem('hh_hold_orders', JSON.stringify(holdOrders));
    updateHoldBadge();
    renderCart();
    closeHoldOrdersModal();
}

function deleteHoldOrder(idx) {
    holdOrders.splice(idx, 1);
    localStorage.setItem('hh_hold_orders', JSON.stringify(holdOrders));
    updateHoldBadge();
    openHoldOrdersModal();
}

// ==========================================
// SAO CHÉP ĐƠN BÁN SỈ (COPY ORDER TỪ LỊCH SỬ RA MÀN HÌNH POS)
// ==========================================
function copyOrderToPosFromBill() {
    if (!currentViewingOrder) return;
    closeBillModal();
    copyOrderToPos(currentViewingOrder);
}

// ==========================================
// ĐÓNG POPUP XEM HÓA ĐƠN & KHUNG SỬA NHANH (FIX LỖI KẸT TRÊN IPHONE)
// ==========================================
function closeBillModal() {
    const modal = document.getElementById('bill-detail-modal');
    if (modal) modal.classList.add('hidden');
    const editBox = document.getElementById('quick-bill-edit-box');
    if (editBox) editBox.classList.add('hidden');
}

function copyOrderToPos(order) {
    if (!order || !Array.isArray(order.items)) return;
    if (Object.keys(cart).length > 0) {
        if (!confirm("Giỏ hàng POS đang có sẵn mặt hàng. Sao chép đơn này sẽ thay thế giỏ hàng hiện tại. Bạn có đồng ý không?")) return;
    }

    cart = {};
    selectedCustomerId = (order.customerId && customers.some(c => c.id === order.customerId)) ? order.customerId : 'GUEST';
    syncCustomerSearchDisplay();

    let copiedCount = 0;
    const warnings = [];

    order.items.forEach(oldItem => {
        const prod = inventory.find(i => i.id === oldItem.productId) || inventory.find(i => i.name === oldItem.productName);
        if (!prod || prod.stock <= 0) {
            warnings.push(`- ${oldItem.productName}: Đã hết hàng trong kho`);
            return;
        }

        let uIdx = prod.units.findIndex(u => u.unitName === oldItem.unitName);
        if (uIdx === -1) uIdx = 0;

        const u = prod.units[uIdx];
        const maxPossibleQty = Math.floor(prod.stock / u.conversionRate);
        if (maxPossibleQty <= 0) {
            warnings.push(`- ${prod.name}: Không đủ tồn kho cho đơn vị ${u.unitName} (Tồn: ${prod.stock} ${prod.baseUnit})`);
            return;
        }

        const finalQty = Math.min(oldItem.qty, maxPossibleQty);
        if (finalQty < oldItem.qty) {
            warnings.push(`- ${prod.name}: Đơn cũ ${oldItem.qty} ${u.unitName} -> Chỉ lấy được ${finalQty} ${u.unitName} do giới hạn tồn kho`);
        }

        addToCartWithUnit(prod.id, uIdx, finalQty, !!oldItem.isGift, oldItem.unitPrice);
        copiedCount++;
    });

    switchTab('tab-sell');
    renderSellGrid();
    const warnMsg = warnings.length > 0 ? `\n\n⚠️ LƯU Ý CÁC MÓN THIẾU TỒN:\n${warnings.join('\n')}` : '';
    alert(`📋 Đã sao chép ${copiedCount}/${order.items.length} mặt hàng từ đơn ${order.orderCode} ra màn hình POS!\nBạn chỉ cần chỉnh lại số lượng/giá mới rồi bấm In.${warnMsg}`);
}

// ==========================================
// ĐIỀU HƯỚNG MÀN HÌNH TỔNG QUAN SAPO & MÀN HÌNH POS ĐỘC LẬP (FULL-SCREEN)
// ==========================================
let currentSettlingOrder = null;

window.addEventListener('load', () => {
    if (window.innerWidth <= 767) {
        switchTab('tab-overview');
    }
    setTimeout(loadOverviewDashboard, 600);
});

function openPosScreen(mode = 'COUNTER') {
    document.body.classList.add('pos-fullscreen-active');
    const titleEl = document.getElementById('pos-mode-title');
    if (titleEl) {
        titleEl.innerText = mode === 'DELIVERY' ? '🚚 Bán Giao Hàng (Thu sau)' : '🏪 Bán Tại Quầy';
    }
    switchTab('tab-sell');
}

function closePosScreen() {
    document.body.classList.remove('pos-fullscreen-active');
    switchTab('tab-overview');
    loadOverviewDashboard();
}

function openOrdersWithFilter(filterVal) {
    document.body.classList.remove('pos-fullscreen-active');
    const sel = document.getElementById('ord-filter-type');
    if (sel) sel.value = filterVal;
    switchTab('tab-orders');
    loadOrdersModule();

    if (filterVal === 'PROCESSING') {
        document.querySelectorAll('.mobile-nav-btn').forEach(b => {
            b.classList.remove('text-inni-blue', 'font-bold');
            b.classList.add('text-slate-400');
        });
        const shipBtn = document.getElementById('btn-mobile-tab-shipping');
        if (shipBtn) {
            shipBtn.classList.remove('text-slate-400');
            shipBtn.classList.add('text-inni-blue', 'font-bold');
        }
    }
}

async function loadOverviewDashboard() {
    const storeNameEl = document.getElementById('mobile-home-store-name');
    if (storeNameEl && typeof storeSettings !== 'undefined') {
        storeNameEl.innerText = storeSettings.storeName || "Đại Lý HỒNG ĐIỆP";
    }
    const mobHold = document.getElementById('hold-count-badge-mob');
    if (mobHold) mobHold.innerText = holdOrders.length;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    try {
        const snap = await db.collection("orders").where("dateStr", "==", todayStr).get();
        let todayRev = 0, todayProfit = 0, completedCnt = 0, pendingCnt = 0;

        snap.docs.forEach(d => {
            const o = d.data();
            if (o.orderType === 'RETURN') return;
            if (o.status === 'PROCESSING') {
                pendingCnt++;
            } else {
                completedCnt++;
                todayRev += Number(o.totalAmount) || 0;
                todayProfit += (Number(o.totalAmount) || 0) - (Number(o.totalCost) || 0);
            }
        });

        const revEl = document.getElementById('home-today-revenue');
        if (revEl) {
            revEl.innerText = `${formatmoney(todayRev)} đ`;
            document.getElementById('home-today-orders').innerText = `${completedCnt} đơn`;
            document.getElementById('home-today-pending').innerText = `${pendingCnt} đơn`;
            document.getElementById('home-today-profit').innerText = `${formatmoney(todayProfit)} đ`;
        }

        const shipBadge = document.getElementById('badge-mobile-shipping');
        if (shipBadge) {
            if (pendingCnt > 0) {
                shipBadge.innerText = pendingCnt;
                shipBadge.classList.remove('hidden');
            } else {
                shipBadge.classList.add('hidden');
            }
        }
    } catch (e) {}
}

// ==========================================
// THANH TOÁN ĐƠN HÀNG & LUỒNG "GIAO HÀNG TRƯỚC - THANH TOÁN SAU" (CHUẨN SAPO)
// ==========================================
function getActiveCheckoutContext() {
    if (currentSettlingOrder) {
        const cust = customers.find(c => c.id === currentSettlingOrder.customerId);
        const oldDebt = cust ? (Number(cust.currentDebt) || 0) : (Number(currentSettlingOrder.oldDebt) || 0);
        return { orderTotal: Number(currentSettlingOrder.totalAmount) || 0, cust, oldDebt };
    }
    let orderTotal = 0;
    for (const k in cart) orderTotal += cart[k].price * cart[k].qty;
    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
    return { orderTotal, cust, oldDebt };
}

function openCheckoutModal() {
    if (Object.keys(cart).length === 0) return alert("Giỏ hàng đang trống!");
    currentSettlingOrder = null;

    const { orderTotal, cust, oldDebt } = getActiveCheckoutContext();
    const grandTotal = orderTotal + oldDebt;

    document.getElementById('chk-customer-name').innerText = cust ? `${cust.name} (${cust.phone || 'Không SĐT'})` : "Khách Lẻ (Vãng lai)";
    document.getElementById('chk-order-total').innerText = `${formatmoney(orderTotal)} đ`;
    document.getElementById('chk-old-debt').innerText = `${formatmoney(oldDebt)} đ`;
    document.getElementById('chk-grand-total').innerText = `${formatmoney(grandTotal)} đ`;

    setPaymentMethod('CASH');
    document.getElementById('chk-paid-input').value = formatmoney(orderTotal);
    calcCheckoutDebt();

    document.getElementById('checkout-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('chk-paid-input').select(), 100);
}

// Mở Popup xác nhận thanh toán cho đơn "Đang giao dịch"
function openSettleOrderModal(order) {
    if (!order) return;
    currentSettlingOrder = order;
    const { orderTotal, cust, oldDebt } = getActiveCheckoutContext();
    const grandTotal = orderTotal + oldDebt;
    const snapName = cust ? `${cust.name} (${cust.phone || 'Không SĐT'})` : `${order.customerSnapshot?.name || 'Khách Lẻ'}`;

    document.getElementById('chk-customer-name').innerText = `${snapName} [Chốt đơn: ${order.orderCode}]`;
    document.getElementById('chk-order-total').innerText = `${formatmoney(orderTotal)} đ`;
    document.getElementById('chk-old-debt').innerText = `${formatmoney(oldDebt)} đ`;
    document.getElementById('chk-grand-total').innerText = `${formatmoney(grandTotal)} đ`;

    setPaymentMethod('CASH');
    document.getElementById('chk-paid-input').value = formatmoney(orderTotal);
    calcCheckoutDebt();

    document.getElementById('checkout-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('chk-paid-input').select(), 100);
}

function openSettleOrderModalFromBill() {
    if (!currentViewingOrder) return;
    closeBillModal();
    openSettleOrderModal(currentViewingOrder);
}

function closeCheckoutModal() {
    currentSettlingOrder = null;
    document.getElementById('checkout-modal').classList.add('hidden');
}

function setPaymentMethod(method) {
    currentPaymentMethod = method;
    document.querySelectorAll('.pm-btn').forEach(btn => {
        btn.className = "pm-btn py-2.5 px-2 rounded-lg border border-slate-300 text-slate-600 flex flex-col items-center gap-1";
    });
    const activeBtn = document.getElementById('pm-btn-' + method);
    if (activeBtn) {
        activeBtn.className = "pm-btn py-2.5 px-2 rounded-lg border-2 border-emerald-600 bg-emerald-50 text-emerald-800 flex flex-col items-center gap-1 font-bold";
    }
    if (method === 'DEBT') {
        document.getElementById('chk-paid-input').value = '0';
        calcCheckoutDebt();
    }
}

function fillFullPayment() {
    const { orderTotal, oldDebt } = getActiveCheckoutContext();
    document.getElementById('chk-paid-input').value = formatmoney(orderTotal + oldDebt);
    calcCheckoutDebt();
}

function calcCheckoutDebt() {
    const { orderTotal, oldDebt } = getActiveCheckoutContext();
    const grandTotal = orderTotal + oldDebt;
    const paid = getRawNum('chk-paid-input');
    const labelEl = document.getElementById('chk-balance-label');
    const valEl = document.getElementById('chk-balance-value');

    if (paid >= grandTotal) {
        labelEl.innerText = "Tiền thừa trả lại khách:";
        valEl.innerText = `${formatmoney(paid - grandTotal)} đ`;
        valEl.className = "text-lg font-black text-blue-600";
    } else {
        labelEl.innerText = "Còn nợ lại (Ghi vào Sổ Nợ Phải Thu):";
        valEl.innerText = `${formatmoney(grandTotal - paid)} đ`;
        valEl.className = "text-lg font-black text-red-600";
    }
}

// Tạo đơn "Đang giao dịch" (Màu cam - Trừ kho giữ hàng, in phiếu đi giao, chưa thu tiền)
async function createPendingDeliveryOrder() {
    if (Object.keys(cart).length === 0) return alert("Giỏ hàng đang trống!");

    let orderTotal = 0, totalCost = 0;
    const orderItems = [];

    for (const k in cart) {
        const c = cart[k];
        const baseQty = c.qty * c.conversionRate;
        const lineTotal = c.price * c.qty;
        const lineCost = baseQty * c.costPricePerBase;
        orderTotal += lineTotal;
        totalCost += lineCost;
        orderItems.push({
            productId: c.productId, productName: c.name, baseUnit: c.baseUnit,
            unitName: c.unitName, conversionRate: c.conversionRate, qty: c.qty,
            baseQty, unitPrice: c.price, costPricePerBase: c.costPricePerBase,
            totalPrice: lineTotal, totalCost: lineCost, isGift: !!c.isGift
        });
    }

    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const orderCode = `BH-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const seller = document.getElementById('seller-name').value.trim() || "Chủ Quán";

    try {
        const orderData = {
            orderCode,
            orderType: "SALE",
            status: "PROCESSING", // Đang giao dịch (Màu cam)
            customerId: selectedCustomerId,
            customerSnapshot: cust ? { name: cust.name, phone: cust.phone || '', address: cust.address || '', type: cust.type } : { name: "Khách Lẻ", phone: "", address: "", type: "RETAIL" },
            seller,
            items: orderItems,
            totalAmount: orderTotal,
            totalCost: totalCost,
            oldDebt: oldDebt,
            paidAmount: 0,
            newDebt: oldDebt + orderTotal,
            paymentMethod: "PENDING",
            cashAmount: 0,
            bankAmount: 0,
            dateStr,
            createdAt: Date.now()
        };

        await db.collection("orders").doc(orderCode).set(orderData);

        for (const item of orderItems) {
            const dbProd = inventory.find(i => i.id === item.productId);
            if (dbProd) {
                const startStock = dbProd.stock;
                const endStock = startStock - item.baseQty;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(
                    dbProd.id, dbProd.name, "SALE", orderCode,
                    `Xuất giao chờ TT: ${item.qty} ${item.unitName}${item.isGift ? ' (Tặng 0đ)' : ''}`,
                    startStock, -item.baseQty, endStock
                );
            }
        }

        playBeepSound();
        cart = {};
        renderCart();
        loadOverviewDashboard();
        openPrintableInvoice(orderData);
    } catch (e) {
        alert("Lỗi khi lưu đơn chờ giao: " + e.message);
    }
}

async function confirmPosCheckout() {
    const btn = document.getElementById('btn-confirm-checkout');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const seller = document.getElementById('seller-name').value.trim() || "Chủ Quán";

    // CHỐT THANH TOÁN ĐƠN "ĐANG GIAO DỊCH" -> CHUYỂN SANG "HOÀN THÀNH" (MÀU XANH)
    if (currentSettlingOrder) {
        const ord = currentSettlingOrder;
        const cust = customers.find(c => c.id === ord.customerId);
        const oldDebt = cust ? (Number(cust.currentDebt) || 0) : (Number(ord.oldDebt) || 0);
        const orderTotal = Number(ord.totalAmount) || 0;
        const grandTotal = orderTotal + oldDebt;
        const rawPaid = getRawNum('chk-paid-input');
        const actualPaidRecorded = Math.min(rawPaid, grandTotal);
        const newDebt = Math.max(0, grandTotal - actualPaidRecorded);

        if (newDebt > 0 && (!ord.customerId || ord.customerId === 'GUEST')) {
            return alert("Đơn Khách Lẻ không thể Ghi nợ phần tiền thiếu! Vui lòng thu đủ hoặc chọn khách hàng.");
        }

        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang chốt đơn...`;

        try {
            const updatedFields = {
                status: "COMPLETED",
                oldDebt,
                paidAmount: actualPaidRecorded,
                newDebt,
                paymentMethod: currentPaymentMethod,
                cashAmount: currentPaymentMethod === 'CASH' ? actualPaidRecorded : 0,
                bankAmount: currentPaymentMethod === 'BANK' ? actualPaidRecorded : 0,
                completedAt: Date.now()
            };

            await db.collection("orders").doc(ord.orderCode).update(updatedFields);

            if (cust && newDebt !== oldDebt) {
                await db.collection("customers").doc(cust.id).update({ currentDebt: newDebt, updatedAt: Date.now() });
                await db.collection("debts").add({
                    customerId: cust.id, customerName: cust.name, ledgerType: "RECEIVABLE",
                    transactionType: "ORDER_DEBT", referenceId: ord.orderCode,
                    beforeDebt: oldDebt, changeAmount: newDebt - oldDebt, afterDebt: newDebt,
                    note: `Chốt thanh toán đơn giao ${ord.orderCode} (Tổng: ${formatmoney(orderTotal)}đ, Trả: ${formatmoney(actualPaidRecorded)}đ)`,
                    createdAt: Date.now()
                });
            }

            if (actualPaidRecorded > 0) {
                await db.collection("cashbook").add({
                    voucherCode: "PT-" + ord.orderCode.split('-').pop(), type: "INCOME",
                    channel: currentPaymentMethod === 'BANK' ? 'BANK' : 'CASH', category: "SALE",
                    amount: actualPaidRecorded, referenceId: ord.orderCode,
                    note: `Thu tiền chốt đơn giao ${ord.orderCode} (${cust ? cust.name : (ord.customerSnapshot?.name || 'Khách lẻ')})`,
                    seller, dateStr, createdAt: Date.now()
                });
            }

            const finalOrder = { ...ord, ...updatedFields };
            playBeepSound();
            closeCheckoutModal();
            loadOrdersModule();
            loadOverviewDashboard();
            openPrintableInvoice(finalOrder);
        } catch (e) {
            alert("Lỗi khi chốt thanh toán: " + e.message);
        }

        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-print"></i> Hoàn Tất & Xuất Hóa Đơn`;
        return;
    }

    // THANH TOÁN TRỰC TIẾP TẠI QUẦY
    let orderTotal = 0, totalCost = 0;
    const orderItems = [];

    for (const k in cart) {
        const c = cart[k];
        const baseQty = c.qty * c.conversionRate;
        const lineTotal = c.price * c.qty;
        const lineCost = baseQty * c.costPricePerBase;
        orderTotal += lineTotal;
        totalCost += lineCost;
        orderItems.push({
            productId: c.productId, productName: c.name, baseUnit: c.baseUnit,
            unitName: c.unitName, conversionRate: c.conversionRate, qty: c.qty,
            baseQty, unitPrice: c.price, costPricePerBase: c.costPricePerBase,
            totalPrice: lineTotal, totalCost: lineCost, isGift: !!c.isGift
        });
    }

    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
    const grandTotal = orderTotal + oldDebt;
    const rawPaid = getRawNum('chk-paid-input');
    const actualPaidRecorded = Math.min(rawPaid, grandTotal);
    const newDebt = Math.max(0, grandTotal - actualPaidRecorded);

    if (newDebt > 0 && selectedCustomerId === 'GUEST') {
        return alert("Khách Lẻ vãng lai không thể Ghi nợ! Vui lòng bấm nút [+] chọn hoặc tạo Tên Khách Hàng trước khi ghi nợ.");
    }

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý đơn...`;
    const orderCode = `BH-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        const orderData = {
            orderCode,
            orderType: "SALE",
            status: "COMPLETED",
            customerId: selectedCustomerId,
            customerSnapshot: cust ? { name: cust.name, phone: cust.phone || '', address: cust.address || '', type: cust.type } : { name: "Khách Lẻ", phone: "", address: "", type: "RETAIL" },
            seller,
            items: orderItems,
            totalAmount: orderTotal,
            totalCost: totalCost,
            oldDebt: oldDebt,
            paidAmount: actualPaidRecorded,
            newDebt: newDebt,
            paymentMethod: currentPaymentMethod,
            cashAmount: currentPaymentMethod === 'CASH' ? actualPaidRecorded : 0,
            bankAmount: currentPaymentMethod === 'BANK' ? actualPaidRecorded : 0,
            dateStr,
            createdAt: Date.now()
        };

        await db.collection("orders").doc(orderCode).set(orderData);

        for (const item of orderItems) {
            const dbProd = inventory.find(i => i.id === item.productId);
            if (dbProd) {
                const startStock = dbProd.stock;
                const endStock = startStock - item.baseQty;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(
                    dbProd.id, dbProd.name, "SALE", orderCode,
                    `Xuất ${item.qty} ${item.unitName}${item.isGift ? ' (Tặng 0đ)' : ''}`,
                    startStock, -item.baseQty, endStock
                );
            }
        }

        if (cust && newDebt !== oldDebt) {
            await db.collection("customers").doc(cust.id).update({ currentDebt: newDebt, updatedAt: Date.now() });
            await db.collection("debts").add({
                customerId: cust.id, customerName: cust.name, ledgerType: "RECEIVABLE",
                transactionType: "ORDER_DEBT", referenceId: orderCode,
                beforeDebt: oldDebt, changeAmount: newDebt - oldDebt, afterDebt: newDebt,
                note: `Mua đơn ${orderCode} (Tổng: ${formatmoney(orderTotal)}đ, Trả: ${formatmoney(actualPaidRecorded)}đ)`,
                createdAt: Date.now()
            });
        }

        if (actualPaidRecorded > 0) {
            await db.collection("cashbook").add({
                voucherCode: "PT-" + orderCode.split('-').pop(), type: "INCOME",
                channel: currentPaymentMethod === 'BANK' ? 'BANK' : 'CASH', category: "SALE",
                amount: actualPaidRecorded, referenceId: orderCode,
                note: `Thu tiền bán hàng đơn ${orderCode} (${cust ? cust.name : 'Khách lẻ'})`,
                seller, dateStr, createdAt: Date.now()
            });
        }

        playBeepSound();
        closeCheckoutModal();
        cart = {};
        renderCart();
        loadOverviewDashboard();
        openPrintableInvoice(orderData);
    } catch (e) {
        alert("Lỗi khi lưu đơn hàng: " + e.message);
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-print"></i> Hoàn Tất & Xuất Hóa Đơn`;
}

// ==========================================
// MODULE 4: HÓA ĐƠN IN PRE-RENDER SIÊU TỐC (SETTIMEOUT 400MS) & LỊCH SỬ ĐƠN
// ==========================================
function setInvoicePrintMode(mode) {
    document.body.classList.remove('print-mode-A5', 'print-mode-80mm');
    document.body.classList.add('print-mode-' + mode);

    const btnA5 = document.getElementById('btn-mode-A5');
    const btn80 = document.getElementById('btn-mode-80mm');
    if (mode === 'A5') {
        btnA5.className = "px-2.5 py-1.5 rounded text-xs font-bold bg-blue-600 text-white cursor-pointer";
        btn80.className = "px-2.5 py-1.5 rounded text-xs font-bold bg-slate-700 text-slate-300 cursor-pointer";
    } else {
        btn80.className = "px-2.5 py-1.5 rounded text-xs font-bold bg-blue-600 text-white cursor-pointer";
        btnA5.className = "px-2.5 py-1.5 rounded text-xs font-bold bg-slate-700 text-slate-300 cursor-pointer";
    }
}

function syncToPreRenderedPrintArea() {
    const source = document.getElementById('printable-bill');
    const target = document.getElementById('pre-rendered-print-area');
    if (source && target) {
        target.innerHTML = source.innerHTML;
    }
}

// Tính tổng số lượng trên hóa đơn: tách rõ từng đơn vị bán & quy đổi chuẩn về đơn vị cơ sở (không cộng gộp Thùng + Lon)
function buildInvoiceQuantitySummary(items) {
    if (!Array.isArray(items) || items.length === 0) return "0";

    const soldUnitCounts = {};
    const baseUnitCounts = {};
    let hasConversion = false;

    items.forEach(item => {
        const qty = Number(item.qty) || 0;
        if (qty <= 0) return;

        const uName = (item.unitName || item.baseUnit || 'ĐV').trim();
        const bUnit = (item.baseUnit || uName).trim();
        const rate = Number(item.conversionRate) || 1;
        if (rate > 1) hasConversion = true;
        const baseQty = Number(item.baseQty) || (qty * rate);

        soldUnitCounts[uName] = (soldUnitCounts[uName] || 0) + qty;
        baseUnitCounts[bUnit] = (baseUnitCounts[bUnit] || 0) + baseQty;
    });

    const soldParts = Object.entries(soldUnitCounts).map(([u, q]) => `${formatmoney(q)} ${u}`);
    const baseParts = Object.entries(baseUnitCounts).map(([bu, bq]) => `${formatmoney(bq)} ${bu}`);

    if (soldParts.length === 0) return "0";
    if (hasConversion || soldParts.length > 1) {
        return `${soldParts.join(' + ')} (Quy đổi: ${baseParts.join(', ')})`;
    }
    return soldParts.join(' + ');
}

function triggerFastAirPrint() {
    const editBox = document.getElementById('quick-bill-edit-box');
    if (editBox) editBox.classList.add('hidden');

    const source = document.getElementById('printable-bill');
    if (!source) return;

    let iframe = document.getElementById('print-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'print-iframe';
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
    }

    const is80mm = document.body.classList.contains('print-mode-80mm');
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <title>In Hóa Đơn</title>
            <script src="https://cdn.tailwindcss.com"><\/script>
            <style>
                /* Giữ nguyên căn lề A5 trong trang A4 đang hoạt động ổn định trên iPhone AirPrint */
                @page {
                    size: ${is80mm ? '80mm auto' : 'A5 portrait'};
                    margin: ${is80mm ? '4mm' : '5mm'};
                }
                *, *::before, *::after { box-sizing: border-box !important; }
                body, body * {
                    font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
                }
                .font-black {
                    font-weight: 700 !important;
                }
                    background: #fff;
                    color: #000;
                    margin: 0;
                    padding: 0;
                    line-height: 1.2 !important;
                }
                .a5-print-container {
                    width: ${is80mm ? '76mm' : '118mm'} !important;
                    max-width: ${is80mm ? '76mm' : '118mm'} !important;
                    margin: 0 auto !important;
                    padding: 4mm !important;
                    box-sizing: border-box !important;
                    font-size: 11px !important;
                    overflow: hidden !important;
                }
                table {
                    width: 100% !important;
                    table-layout: fixed !important;
                    border-collapse: collapse !important;
                    box-sizing: border-box !important;
                    margin-bottom: 3px !important;
                }
                th, td {
                    border: 1px solid #64748b;
                    padding: 2px 4px !important;
                    line-height: 1.15 !important;
                    font-size: 11px !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                    white-space: normal !important;
                }
                /* Đồng bộ 6 cột chuẩn 100%: STT 7% | Tên hàng 41% | ĐVT 10% | SL 8% | Đơn giá 16% | Thành tiền 18% */
                .col-stt { width: 7% !important; white-space: nowrap !important; ${is80mm ? 'display:none;' : ''} }
                .col-name { width: ${is80mm ? '48%' : '41%'} !important; }
                .col-unit { width: 10% !important; white-space: nowrap !important; }
                .col-qty { width: 8% !important; white-space: nowrap !important; }
                .col-price { width: 16% !important; white-space: nowrap !important; }
                .col-total { width: 18% !important; white-space: nowrap !important; }
                .vietqr-header-img {
                    width: 65px !important;
                    height: 65px !important;
                    object-fit: contain !important;
                }
            </style>
        </head>
        <body>
            <div class="a5-print-container">
                ${source.innerHTML}
            </div>
        </body>
        </html>
    `);
    doc.close();

    setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
    }, 180);
}

// MODULE 4: Xuất Ảnh Hóa Đơn PNG (Clone ra khung A5 cố định, chống cắt đầu & đồng bộ style A5)
async function exportBillToImage() {
    const billEl = document.getElementById('printable-bill');
    const modalEl = document.getElementById('bill-detail-modal');
    const btn = document.getElementById('btn-export-bill-img');
    if (!billEl || typeof html2canvas === 'undefined') {
        return alert("Không tìm thấy thư viện chụp ảnh hóa đơn!");
    }

    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang tạo ảnh...`;
    }

    let cloneWrapper = null;
    try {
        // 1. Reset vị trí cuộn của khung bill và modal về 0
        billEl.scrollTop = 0;
        if (modalEl) modalEl.scrollTop = 0;

        // 2. Tạo thẻ div tạm tách biệt hoàn toàn với thanh cuộn của iPhone, khóa chiều rộng chuẩn A5 (520px)
        cloneWrapper = document.createElement('div');
        cloneWrapper.style.cssText = "position: absolute; top: 0; left: -9999px; width: 520px; max-width: 520px; height: auto; overflow: visible; background: #ffffff; padding: 16px 18px; box-sizing: border-box; z-index: -1; color: #000000; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; line-height: 1.4;";
        cloneWrapper.innerHTML = `
            <style>
                .export-a5-clone, .export-a5-clone * { box-sizing: border-box !important; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; }
                .export-a5-clone .font-black { font-weight: 700 !important; }
                .export-a5-clone table { width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; margin-bottom: 4px !important; }
                .export-a5-clone th, .export-a5-clone td { border: 1px solid #64748b !important; padding: 2px 4px !important; line-height: 1.15 !important; font-size: 11px !important; }
                .export-a5-clone .col-stt { width: 7% !important; white-space: nowrap !important; text-align: center !important; }
                .export-a5-clone .col-name { width: 41% !important; word-wrap: break-word !important; white-space: normal !important; }
                .export-a5-clone .col-unit { width: 10% !important; white-space: nowrap !important; text-align: center !important; }
                .export-a5-clone .col-qty { width: 8% !important; white-space: nowrap !important; text-align: center !important; }
                .export-a5-clone .col-price { width: 16% !important; white-space: nowrap !important; text-align: right !important; }
                .export-a5-clone .col-total { width: 18% !important; white-space: nowrap !important; text-align: right !important; }
                .export-a5-clone .vietqr-header-img { width: 65px !important; height: 65px !important; object-fit: contain !important; }
            </style>
            <div class="export-a5-clone">${billEl.innerHTML}</div>
        `;
        document.body.appendChild(cloneWrapper);

        // Đảm bảo ảnh QR bên trong bản clone có crossOrigin="anonymous" và đã tải xong trước khi chụp
        const imgs = Array.from(cloneWrapper.querySelectorAll('img'));
        await Promise.all(imgs.map(img => {
            if (!img.getAttribute('src')) return Promise.resolve();
            img.crossOrigin = "anonymous";
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise(res => {
                img.onload = res;
                img.onerror = res;
            });
        }));

        // 3. Khóa tọa độ chụp trọn vẹn từ đỉnh (y: 0) đến đáy của bản clone
        const canvas = await html2canvas(cloneWrapper, {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            scrollX: 0,
            scrollY: -window.scrollY,
            windowWidth: cloneWrapper.scrollWidth,
            windowHeight: cloneWrapper.scrollHeight,
            width: cloneWrapper.scrollWidth,
            height: cloneWrapper.scrollHeight,
            x: 0,
            y: 0
        });

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error("Không thể khởi tạo file ảnh PNG");

        const code = currentViewingOrder?.orderCode || 'HoaDon';
        const fileName = `HoaDon_${code}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                title: `Hóa đơn ${code}`,
                text: `Hóa đơn bán hàng ${code} - ${storeSettings.storeName || ''}`,
                files: [file]
            });
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            alert("Lỗi khi xuất ảnh hóa đơn: " + err.message);
        }
    } finally {
        if (cloneWrapper && cloneWrapper.parentNode) {
            cloneWrapper.parentNode.removeChild(cloneWrapper);
        }
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}

function toggleQuickBillHeaderEdit() {
    const box = document.getElementById('quick-bill-edit-box');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
        document.getElementById('qb-store-name').value = storeSettings.storeName || "Đại Lý HỒNG ĐIỆP";
        document.getElementById('qb-store-phone').value = storeSettings.phone || "";
        document.getElementById('qb-store-address').value = storeSettings.address || "";
        document.getElementById('qb-bank-id').value = storeSettings.bankId || "MB";
        document.getElementById('qb-bank-acc').value = storeSettings.bankAcc || "";
        document.getElementById('qb-bank-owner').value = storeSettings.bankOwner || "";
        const st = document.getElementById('qb-save-status');
        if (st) st.innerText = "";
    }
}

function applyQuickBillHeaderEdit() {
    storeSettings.storeName = document.getElementById('qb-store-name').value.trim() || "Đại Lý HỒNG ĐIỆP";
    storeSettings.phone = document.getElementById('qb-store-phone').value.trim();
    storeSettings.address = document.getElementById('qb-store-address').value.trim();
    storeSettings.bankId = document.getElementById('qb-bank-id').value;
    storeSettings.bankAcc = document.getElementById('qb-bank-acc').value.trim();
    storeSettings.bankOwner = document.getElementById('qb-bank-owner').value.trim().toUpperCase();

    localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
    if (typeof applyStoreSettingsToUI === 'function') applyStoreSettingsToUI();

    const qrBox = document.getElementById('bill-vietqr-box');
    const qrImg = document.getElementById('bill-vietqr-img');
    const bankInfo = document.getElementById('bill-bank-info');

    if (storeSettings.bankAcc && storeSettings.bankId) {
        const accName = encodeURIComponent(storeSettings.bankOwner || "");
        qrImg.crossOrigin = "anonymous";
        qrImg.src = `https://img.vietqr.io/image/${storeSettings.bankId}-${storeSettings.bankAcc}-qr_only.png?accountName=${accName}`;
        bankInfo.innerText = `${storeSettings.bankId}: ${storeSettings.bankAcc}\n${storeSettings.bankOwner || ''}`;
        qrBox.classList.remove('hidden');
    } else {
        qrBox.classList.add('hidden');
    }
    syncToPreRenderedPrintArea();
}

async function saveQuickBillHeaderConfig() {
    applyQuickBillHeaderEdit();
    const st = document.getElementById('qb-save-status');
    const btn = document.getElementById('btn-save-qb-config');
    if (st) st.innerText = "Đang lưu...";
    if (btn) btn.disabled = true;

    try {
        storeSettings.updatedAt = Date.now();
        localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
        await db.collection("shop_data").doc("settings").set(storeSettings, { merge: true });
        if (st) {
            st.innerText = "✅ Đã lưu cấu hình thành công!";
            st.className = "text-[11px] text-emerald-700 font-bold";
        }
    } catch (e) {
        if (st) {
            st.innerText = "⚠️ Đã lưu tại máy (Lỗi Cloud: " + e.message + ")";
            st.className = "text-[11px] text-amber-700 font-bold";
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function openPrintableInvoice(order) {
    currentViewingOrder = order;
    setInvoicePrintMode(storeSettings.printSize || 'A5');
    document.getElementById('quick-bill-edit-box')?.classList.add('hidden');

    document.getElementById('bill-store-name').innerText = (storeSettings.storeName || "Đại Lý HỒNG ĐIỆP").toUpperCase();
    document.getElementById('bill-store-phone').innerText = storeSettings.phone || "---";
    document.getElementById('bill-store-address').innerText = storeSettings.address || "";

    const isPending = order.status === 'PROCESSING';
    document.getElementById('bill-title-type').innerText = order.orderType === 'RETURN'
        ? 'PHIẾU HOÀN TRẢ HÀNG'
        : (isPending ? 'PHIẾU GIAO HÀNG (ĐANG GIAO DỊCH)' : 'HÓA ĐƠN BÁN HÀNG');
    document.getElementById('bill-detail-id').innerText = order.orderCode;
    document.getElementById('bill-detail-date').innerText = new Date(order.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
    document.getElementById('bill-detail-seller').innerText = order.seller || "Chủ Quán";

    const snap = order.customerSnapshot || { name: "Khách Lẻ", phone: "", address: "" };
    document.getElementById('bill-cust-name').innerText = snap.name || "Khách Lẻ";
    document.getElementById('bill-cust-phone').innerText = snap.phone || "Không SĐT";
    document.getElementById('bill-cust-address').innerText = snap.address || "---";

    const items = order.items || [];
    const tbody = document.getElementById('bill-detail-items');
    tbody.innerHTML = items.map((item, idx) => {
        const giftLabel = item.isGift ? ` (Tặng 0đ)` : '';
        return `
            <tr>
                <td class="border border-slate-400 text-center a5-only-col col-stt" style="width:7%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; white-space: nowrap;">${idx + 1}</td>
                <td class="border border-slate-400 font-semibold col-name" style="width:41%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; word-wrap: break-word; overflow-wrap: break-word; white-space: normal;">${item.productName}${giftLabel}</td>
                <td class="border border-slate-400 text-center col-unit" style="width:10%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; white-space: nowrap;">${item.unitName}</td>
                <td class="border border-slate-400 text-center font-bold col-qty" style="width:8%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; white-space: nowrap;">${item.qty}</td>
                <td class="border border-slate-400 text-right col-price" style="width:16%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; white-space: nowrap;">${formatmoney(item.unitPrice)}</td>
                <td class="border border-slate-400 text-right font-bold col-total" style="width:18%; padding: 5px 4px 7px 4px !important; line-height: 1.4 !important; vertical-align: middle !important; white-space: nowrap;">${formatmoney(item.totalPrice)}</td>
            </tr>
        `;
    }).join('');

    const totalQtyLine = document.getElementById('bill-total-qty-line');
    if (totalQtyLine) {
        totalQtyLine.innerText = `Tổng số lượng: ${buildInvoiceQuantitySummary(items)}`;
    }

    document.getElementById('bill-detail-total').innerText = `${formatmoney(order.totalAmount)} đ`;
    document.getElementById('bill-old-debt').innerText = `${formatmoney(order.oldDebt || 0)} đ`;
    document.getElementById('bill-paid-amount').innerText = `${formatmoney(order.paidAmount || 0)} đ`;
    document.getElementById('bill-new-debt').innerText = `${formatmoney(order.newDebt || 0)} đ`;

    const qrBox = document.getElementById('bill-vietqr-box');
    const qrImg = document.getElementById('bill-vietqr-img');
    const bankInfo = document.getElementById('bill-bank-info');

    if (storeSettings.bankAcc && storeSettings.bankId) {
        const accName = encodeURIComponent(storeSettings.bankOwner || "");
        qrImg.src = `https://img.vietqr.io/image/${storeSettings.bankId}-${storeSettings.bankAcc}-qr_only.png?accountName=${accName}`;
        bankInfo.innerText = `${storeSettings.bankId}: ${storeSettings.bankAcc}\n${storeSettings.bankOwner || ''}`;
        qrBox.classList.remove('hidden');
    } else {
        qrBox.classList.add('hidden');
    }

    const btnSettle = document.getElementById('btn-settle-from-bill');
    if (btnSettle) {
        if (isPending) btnSettle.classList.remove('hidden');
        else btnSettle.classList.add('hidden');
    }

    const btnRet = document.getElementById('btn-open-return-from-bill');
    if (order.orderType === 'RETURN' || isPending) btnRet.classList.add('hidden');
    else btnRet.classList.remove('hidden');

    syncToPreRenderedPrintArea();
    document.getElementById('bill-detail-modal').classList.remove('hidden');
}

let ordFetchLimit = 50;

function loadMoreOrders() {
    ordFetchLimit += 50;
    loadOrdersModule(false);
}

async function loadOrdersModule(resetLimit = true) {
    if (resetLimit) ordFetchLimit = 50;
    const fromStr = document.getElementById('ord-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('ord-date-to')?.value || '2060-12-31';
    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải danh sách đơn hàng...</td></tr>`;

    try {
        const snap = await db.collection("orders")
            .where("dateStr", ">=", fromStr)
            .where("dateStr", "<=", toStr)
            .limit(ordFetchLimit)
            .get();

        ordersList = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);
        renderOrdersList();
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-red-500">Lỗi tải hóa đơn: ${e.message}</td></tr>`;
    }
}

function renderOrdersList() {
    const tbody = document.getElementById('orders-tbody');
    const mobList = document.getElementById('orders-mobile-list');
    const emptyEl = document.getElementById('orders-empty');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (mobList) mobList.innerHTML = '';

    const search = (document.getElementById('ord-search-text')?.value || '').toLowerCase().trim();
    const typeFilter = document.getElementById('ord-filter-type')?.value || 'all';
    let count = 0;

    ordersList.forEach((ord, idx) => {
        const isReturn = ord.orderType === 'RETURN';
        const isPending = ord.status === 'PROCESSING';

        if (typeFilter === 'PROCESSING' && !isPending) return;
        if (typeFilter === 'COMPLETED' && (isPending || isReturn)) return;
        if (typeFilter === 'RETURN' && !isReturn) return;
        if (typeFilter === 'SALE' && isReturn) return;

        const custName = ord.customerSnapshot?.name || 'Khách Lẻ';
        const custPhone = ord.customerSnapshot?.phone || '';
        if (search && !ord.orderCode.toLowerCase().includes(search) && !custName.toLowerCase().includes(search) && !custPhone.includes(search)) return;

        count++;
        const timeStr = new Date(ord.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const itemsText = (ord.items || []).map(i => `${i.productName} (${i.qty} ${i.unitName})`).join(', ');

        let badge = '';
        if (isReturn) {
            badge = `<span class="bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 rounded-full">HOÀN HÀNG</span>`;
        } else if (isPending) {
            badge = `<span class="bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-black px-2 py-0.5 rounded-full">ĐANG GIAO DỊCH</span>`;
        } else {
            badge = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full">HOÀN THÀNH</span>`;
        }

        // Render Bảng trên PC
        tbody.innerHTML += `
            <tr class="${isPending ? 'bg-amber-50/40' : 'hover:bg-blue-50/40'} transition">
                <td class="p-3">
                    <div class="font-bold text-inni-blue flex items-center gap-1.5 flex-wrap">${ord.orderCode} ${badge}</div>
                    <div class="text-xs text-slate-400 mt-0.5">${timeStr} • TN: ${ord.seller || 'Chủ Quán'}</div>
                </td>
                <td class="p-3">
                    <div class="font-bold text-slate-800">${custName} ${custPhone ? `<span class="text-xs font-normal text-slate-500">(${custPhone})</span>` : ''}</div>
                </td>
                <td class="p-3 text-xs text-slate-600 max-w-xs truncate" title="${itemsText}">${itemsText}</td>
                <td class="p-3 text-right font-black whitespace-nowrap ${isReturn ? 'text-purple-700' : 'text-slate-800'}">${formatmoney(ord.totalAmount)} đ</td>
                <td class="p-3 text-right font-semibold text-emerald-600 whitespace-nowrap">${isPending ? '<span class="text-amber-600 italic text-xs">Chờ thu</span>' : `${formatmoney(ord.paidAmount || 0)} đ`}</td>
                <td class="p-3 text-right font-bold text-red-600 whitespace-nowrap">${isPending ? `${formatmoney(ord.totalAmount)} đ` : `${formatmoney(ord.newDebt || 0)} đ`}</td>
                <td class="p-3 text-center whitespace-nowrap pt-2">
                    ${isPending ? `
                    <button onclick="openSettleOrderModal(ordersList[${idx}])" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black transition scale-active mr-1 shadow-sm">
                        <i class="fa-solid fa-hand-holding-dollar"></i> Xác Nhận Thanh Toán
                    </button>` : ''}
                    <button onclick="openPrintableInvoice(ordersList[${idx}])" class="px-3 py-2 bg-blue-50 hover:bg-inni-blue text-inni-blue hover:text-white rounded-xl text-xs font-bold transition scale-active mr-1">
                        <i class="fa-solid fa-print"></i> In
                    </button>
                    <button onclick="copyOrderToPos(ordersList[${idx}])" class="px-3 py-2 bg-amber-50 hover:bg-amber-500 text-amber-700 hover:text-white rounded-xl text-xs font-bold transition scale-active mr-1">
                        <i class="fa-solid fa-copy"></i> Sao Chép
                    </button>
                    ${(!isReturn && !isPending) ? `
                    <button onclick="openReturnOrderModal(ordersList[${idx}])" class="px-3 py-2 bg-purple-50 hover:bg-purple-600 text-purple-700 hover:text-white rounded-xl text-xs font-bold transition scale-active">
                        <i class="fa-solid fa-rotate-left"></i> Hoàn
                    </button>` : ''}
                </td>
            </tr>
        `;

        // Render Danh sách phẳng (Flat List 2 cột Trái-Phải) trên Mobile
        if (mobList) {
            const statusText = isReturn
                ? `<span class="text-xs font-semibold text-purple-600">Hoàn hàng</span>`
                : (isPending
                    ? `<span class="text-xs font-semibold text-amber-500">Đang giao dịch</span>`
                    : `<span class="text-xs font-semibold text-slate-400">Hoàn thành</span>`);

            mobList.innerHTML += `
                <div onclick="openPrintableInvoice(ordersList[${idx}])" class="p-3.5 flex justify-between items-center active:bg-slate-50 cursor-pointer">
                    <div class="space-y-0.5">
                        <div class="font-bold text-slate-800 text-sm">${ord.orderCode}</div>
                        <div class="text-xs text-slate-600">${custName}</div>
                        <div class="text-[11px] text-slate-400">${timeStr}</div>
                    </div>
                    <div class="text-right space-y-1">
                        <div class="font-bold text-slate-800 text-sm">${formatmoney(ord.totalAmount)} đ</div>
                        <div>${statusText}</div>
                    </div>
                </div>
            `;
        }
    });

    const cntLabel = document.getElementById('ord-count-label');
    if (cntLabel) cntLabel.innerText = `${count} đơn hàng`;
    const moreWrap = document.getElementById('ord-load-more-wrap');
    if (moreWrap) moreWrap.classList.toggle('hidden', ordersList.length < ordFetchLimit);

    if (count === 0) emptyEl.classList.remove('hidden');
    else emptyEl.classList.add('hidden');
}

async function deleteEntireOrder() {
    if (!currentViewingOrder) return;
    const ord = currentViewingOrder;
    if (!confirm(`Bạn có chắc muốn HỦY HÓA ĐƠN "${ord.orderCode}"?\n- Hàng hóa sẽ được hoàn trả lại kho.\n- Tiền thu trong Sổ Quỹ & Công nợ của đơn này sẽ tự động xóa sạch để đồng bộ!`)) return;

    try {
        // 1. Hoàn trả lại tồn kho
        for (const item of (ord.items || [])) {
            const dbProd = inventory.find(i => i.id === item.productId);
            if (dbProd) {
                const startStock = dbProd.stock;
                const change = ord.orderType === 'RETURN' ? -item.baseQty : item.baseQty;
                const endStock = startStock + change;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(dbProd.id, dbProd.name, "ADJUST", `HỦY-${ord.orderCode}`, `Hoàn kho do hủy đơn`, startStock, change, endStock);
            }
        }

        // 2. Đảo ngược công nợ khách hàng (Chỉ áp dụng nếu đơn đã chốt COMPLETED, vì đơn PROCESSING chưa cộng vào nợ khách)
        if (ord.status !== 'PROCESSING' && ord.customerId && ord.customerId !== 'GUEST') {
            const cust = customers.find(c => c.id === ord.customerId);
            const debtDiff = (ord.newDebt || 0) - (ord.oldDebt || 0);
            if (cust && debtDiff !== 0) {
                const updatedDebt = Math.max(0, (cust.currentDebt || 0) - debtDiff);
                await db.collection("customers").doc(cust.id).update({ currentDebt: updatedDebt, updatedAt: Date.now() });
            }
            const debtSnap = await db.collection("debts").where("referenceId", "==", ord.orderCode).get();
            for (const dDoc of debtSnap.docs) {
                await dDoc.ref.delete();
            }
        }

        // 3. XÓA PHIẾU THU/CHI TRONG SỔ QUỸ (CASHBOOK) CỦA ĐƠN NÀY ĐỂ ĐỒNG BỘ TIỀN
        const cbSnap = await db.collection("cashbook").where("referenceId", "==", ord.orderCode).get();
        for (const cbDoc of cbSnap.docs) {
            await cbDoc.ref.delete();
        }

        // 4. Xóa đơn hàng
        await db.collection("orders").doc(ord.orderCode).delete();

        closeBillModal();
        loadOrdersModule();
        if (typeof loadCashbookModule === 'function') loadCashbookModule();
        if (typeof loadReportsModule === 'function') loadReportsModule();
        alert(`✅ Đã hủy hóa đơn ${ord.orderCode}!\nĐã hoàn kho, xóa phiếu thu Sổ quỹ và cập nhật lại Báo cáo Lãi/Lỗ!`);
    } catch (e) {
        alert("Lỗi khi hủy đơn: " + e.message);
    }
}

function exportOrdersToCSV() {
    if (ordersList.length === 0) return alert("Không có dữ liệu hóa đơn để xuất!");
    let csv = "data:text/csv;charset=utf-8,\uFEFF";
    csv += "Ngày,Mã Hóa Đơn,Loại Đơn,Khách Hàng,Thu Ngân,Sản Phẩm,ĐVT,Số Lượng,Đơn Giá,Thành Tiền,Tổng Đơn,Nợ Cũ,Đã Thanh Toán,Còn Nợ\n";

    ordersList.forEach(ord => {
        const custName = `"${(ord.customerSnapshot?.name || 'Khách Lẻ').replace(/"/g, '""')}"`;
        (ord.items || []).forEach((item, idx) => {
            const pName = `"${item.productName.replace(/"/g, '""')}"`;
            if (idx === 0) {
                csv += `${ord.dateStr},${ord.orderCode},${ord.orderType},${custName},${ord.seller},${pName},${item.unitName},${item.qty},${item.unitPrice},${item.totalPrice},${ord.totalAmount},${ord.oldDebt||0},${ord.paidAmount||0},${ord.newDebt||0}\n`;
            } else {
                csv += `,,,,,${pName},${item.unitName},${item.qty},${item.unitPrice},${item.totalPrice},,,,\n`;
            }
        });
    });

    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csv));
    link.setAttribute("download", `Hoa_Don_Huy_Hoang_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ==========================================
// MODULE 3: QUẢN LÝ KHÁCH HÀNG (SỈ/LẺ/NCC), IMPORT EXCEL & HOÀN HÀNG MỘT PHẦN
// ==========================================
function renderCrmModule() {
    const tbody = document.getElementById('crm-tbody');
    const emptyEl = document.getElementById('crm-empty');
    if (!tbody) return;
    tbody.innerHTML = '';

    const search = (document.getElementById('crm-search-text')?.value || '').toLowerCase().trim();
    const typeFilter = document.getElementById('crm-filter-type')?.value || 'all';

    let totalReceivable = 0;
    let totalPayable = 0;
    let rendered = 0;

    customers.forEach(c => {
        const debt = Number(c.currentDebt) || 0;
        if (c.type === 'SUPPLIER') totalPayable += debt;
        else totalReceivable += debt;

        if (typeFilter === 'WHOLESALE' && c.type !== 'WHOLESALE') return;
        if (typeFilter === 'RETAIL' && c.type !== 'RETAIL') return;
        if (typeFilter === 'SUPPLIER' && c.type !== 'SUPPLIER') return;
        if (typeFilter === 'DEBT_ONLY' && debt <= 0) return;

        if (search && !c.name.toLowerCase().includes(search) && !(c.phone || '').includes(search) && !(c.address || '').toLowerCase().includes(search)) return;
        rendered++;

        let typeBadge = '';
        if (c.type === 'SUPPLIER') {
            typeBadge = `<span class="bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded">🚛 Nhà Cung Cấp</span>`;
        } else if (c.type === 'RETAIL') {
            typeBadge = `<span class="bg-slate-200 text-slate-700 text-[11px] font-bold px-2 py-0.5 rounded">👤 Khách Lẻ Quen</span>`;
        } else {
            typeBadge = `<span class="bg-blue-100 text-inni-blue text-[11px] font-bold px-2 py-0.5 rounded">🏪 Khách Sỉ (Áp Giá Sỉ)</span>`;
        }

        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 font-bold text-slate-800">${c.name}</td>
                <td class="p-3 mobile-hide-col">${typeBadge}</td>
                <td class="p-3 font-semibold text-slate-600">${c.phone || '---'}</td>
                <td class="p-3 text-xs text-slate-500 mobile-hide-col">${c.address || '---'}</td>
                <td class="p-3 text-right font-black ${debt > 0 ? 'text-red-600 text-base' : 'text-emerald-600'}">${formatmoney(debt)} đ</td>
                <td class="p-3 text-center whitespace-nowrap">
                    <button onclick="openDebtLedgerModal('${c.id}')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-amber-300 rounded-lg text-xs font-bold shadow-sm scale-active mr-1">
                        <i class="fa-solid fa-book-bookmark mr-1"></i> Sổ Nợ
                    </button>
                    <button onclick="openCustomerModal('${c.id}')" title="Sửa thông tin" class="w-8 h-8 bg-amber-50 hover:bg-amber-500 text-amber-600 hover:text-white rounded-lg inline-flex items-center justify-center border border-amber-200 scale-active mr-1">
                        <i class="fa-solid fa-pen text-xs"></i>
                    </button>
                    <button onclick="deleteCustomer('${c.id}')" title="Xóa đối tác" class="w-8 h-8 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-lg inline-flex items-center justify-center border border-red-200 scale-active">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </td>
            </tr>
        `;
    });

    const cntEl = document.getElementById('crm-stat-count');
    if (cntEl) {
        cntEl.innerText = `${customers.length} đối tác`;
        document.getElementById('crm-stat-receivable').innerText = `${formatmoney(totalReceivable)} đ`;
        document.getElementById('crm-stat-payable').innerText = `${formatmoney(totalPayable)} đ`;
    }

    if (rendered === 0) emptyEl.classList.remove('hidden');
    else emptyEl.classList.add('hidden');
}

function openCustomerModal(id = null) {
    if (!id) {
        document.getElementById('cust-modal-title').innerHTML = `<i class="fa-solid fa-user-plus mr-2"></i>Thêm Khách Hàng / Nhà Cung Cấp`;
        document.getElementById('cust-id').value = '';
        document.getElementById('cust-type').value = 'WHOLESALE';
        document.getElementById('cust-name').value = '';
        document.getElementById('cust-phone').value = '';
        document.getElementById('cust-address').value = '';
        document.getElementById('cust-debt').value = '0';
    } else {
        const c = customers.find(x => x.id === id);
        if (!c) return;
        document.getElementById('cust-modal-title').innerHTML = `<i class="fa-solid fa-user-pen mr-2"></i>Sửa Thông Tin: ${c.name}`;
        document.getElementById('cust-id').value = c.id;
        document.getElementById('cust-type').value = c.type || 'WHOLESALE';
        document.getElementById('cust-name').value = c.name || '';
        document.getElementById('cust-phone').value = c.phone || '';
        document.getElementById('cust-address').value = c.address || '';
        document.getElementById('cust-debt').value = formatmoney(c.currentDebt || 0);
    }
    document.getElementById('customer-modal').classList.remove('hidden');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.add('hidden');
}

async function saveCustomerForm() {
    const id = document.getElementById('cust-id').value;
    const type = document.getElementById('cust-type').value;
    const name = document.getElementById('cust-name').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const address = document.getElementById('cust-address').value.trim();
    const currentDebt = getRawNum('cust-debt');

    if (!name) return alert("Vui lòng nhập Tên khách hàng hoặc Nhà cung cấp!");

    try {
        if (!id) {
            const docRef = await db.collection("customers").add({
                type, name, phone, address, currentDebt, updatedAt: Date.now()
            });
            if (type !== 'SUPPLIER') {
                setTimeout(() => selectPosCustomerFromDropdown(docRef.id), 250);
            }
        } else {
            await db.collection("customers").doc(id).update({
                type, name, phone, address, currentDebt, updatedAt: Date.now()
            });
        }
        closeCustomerModal();
    } catch (e) {
        alert("Lỗi lưu khách hàng: " + e.message);
    }
}

function deleteCustomer(id) {
    const c = customers.find(x => x.id === id);
    if (!c) return;
    if (confirm(`Bạn có chắc chắn muốn XÓA "${c.name}" khỏi danh sách?`)) {
        db.collection("customers").doc(id).delete();
    }
}

// --- IMPORT KHÁCH HÀNG HÀNG LOẠT TỪ FILE EXCEL & TẢI FILE MẪU ---
function downloadCustomerSampleExcel() {
    const sampleData = [
        {
            "Tên khách hàng": "Đại Lý Cô Tư",
            "Phân loại": "Khách Sỉ",
            "SĐT": "0909123456",
            "Địa chỉ": "Chợ Biên Hòa, Đồng Nai",
            "Nợ cũ": 2500000
        },
        {
            "Tên khách hàng": "Anh Minh Quán Nước",
            "Phân loại": "Khách Lẻ",
            "SĐT": "0918888999",
            "Địa chỉ": "Phường Tân Hiệp",
            "Nợ cũ": 0
        },
        {
            "Tên khách hàng": "Đại lý Bia Cấp 1 Sài Gòn",
            "Phân loại": "Nhà Cung Cấp",
            "SĐT": "02513888888",
            "Địa chỉ": "KCN Biên Hòa 2",
            "Nợ cũ": 15000000
        }
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mau_Khach_Hang");
    XLSX.writeFile(wb, "File_Mau_Import_Khach_Hang_Huy_Hoang.xlsx");
}

async function handleImportCustomersExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

            if (rows.length === 0) return alert("File Excel trống!");
            if (!confirm(`Tìm thấy ${rows.length} dòng Khách hàng / NCC từ file Excel. Bạn có muốn đẩy hàng loạt vào hệ thống không?`)) return;

            let importedCount = 0;
            // Đổi 350 thành 200 để tổng lệnh set (customers + debts) luôn <= 400 (an toàn dưới ngưỡng 500 của Firestore)
            for (let i = 0; i < rows.length; i += 200) {
                const chunk = rows.slice(i, i + 200);
                const batch = db.batch();

                chunk.forEach(r => {
                    const name = (r["Tên khách hàng"] || r["Tên"] || r["Name"] || "").toString().trim();
                    if (!name) return;

                    const customerCode = (r["Mã khách hàng"] || r["Mã KH"] || r["Ma KH"] || "").toString().trim();
                    const rawType = removeVN(r["Phân loại"] || "Khách Sỉ");
                    let type = "WHOLESALE";
                    if (rawType.includes("ncc") || rawType.includes("cung cap")) type = "SUPPLIER";
                    else if (rawType.includes("le")) type = "RETAIL";

                    const phone = (r["SĐT"] || r["SDT"] || r["Điện thoại"] || "").toString().trim();
                    const address = (r["Địa chỉ"] || r["Dia chi"] || "").toString().trim();
                    const currentDebt = parseInt((r["Nợ cũ"] || r["No cu"] || 0).toString().replace(/\./g, '').replace(/,/g, '').replace(/\D/g, ''), 10) || 0;

                    const docRef = db.collection("customers").doc();
                    batch.set(docRef, {
                        customerCode, type, name, phone, address, currentDebt, updatedAt: Date.now()
                    });
                    // Thêm bản ghi khởi tạo vào Sổ Nợ nếu khách có Nợ cũ từ Sapo chuyển qua
                    if (currentDebt > 0) {
                        const debtRef = db.collection("debts").doc();
                        batch.set(debtRef, {
                            customerId: docRef.id,
                            customerName: name,
                            ledgerType: type === "SUPPLIER" ? "PAYABLE" : "RECEIVABLE",
                            transactionType: "ORDER_DEBT",
                            referenceId: "NỢ-ĐẦU-KỲ",
                            beforeDebt: 0,
                            changeAmount: currentDebt,
                            afterDebt: currentDebt,
                            note: "Nhập số dư nợ cũ từ file Excel Sapo",
                            createdAt: Date.now()
                        });
                    }
                    importedCount++;
                });

                await batch.commit();
            }

            event.target.value = '';
            alert(`✅ Đã Import thành công ${importedCount} Khách hàng / Nhà cung cấp cùng số tiền Nợ cũ vào hệ thống!`);
        } catch (err) {
            alert("Lỗi đọc file Excel khách hàng: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

// --- SỔ GHI NỢ CHI TIẾT (DEBT LEDGER) - CÓ CHỨC NĂNG SỬA & XÓA ---
async function openDebtLedgerModal(customerId) {
    currentLedgerCustomerId = customerId;
    const c = customers.find(x => x.id === customerId);
    if (!c) return;

    document.getElementById('dl-cust-name').innerText = c.name;
    document.getElementById('dl-cust-summary').innerText = `SĐT: ${c.phone || '---'} • Dư nợ hiện tại: ${formatmoney(c.currentDebt || 0)} đ`;
    document.getElementById('dl-pay-amount').value = c.currentDebt > 0 ? formatmoney(c.currentDebt) : '';
    document.getElementById('dl-pay-note').value = '';
    document.getElementById('debt-ledger-modal').classList.remove('hidden');

    loadDebtLedgerLogs(customerId);
}

function closeDebtLedgerModal() {
    document.getElementById('debt-ledger-modal').classList.add('hidden');
}

async function loadDebtLedgerLogs(customerId) {
    const tbody = document.getElementById('dl-tbody');
    const emptyEl = document.getElementById('dl-empty');
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải sổ nợ...</td></tr>`;

    try {
        const snap = await db.collection("debts").where("customerId", "==", customerId).limit(60).get();
        const logs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
        tbody.innerHTML = '';

        if (logs.length === 0) {
            emptyEl.classList.remove('hidden');
            return;
        }
        emptyEl.classList.add('hidden');

        logs.forEach(log => {
            const dStr = new Date(log.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            let badge = '';
            if (log.transactionType === 'ORDER_DEBT') badge = `<span class="bg-red-100 text-red-700 text-[10px] font-bold px-2 py-0.5 rounded">GHI NỢ ĐƠN</span>`;
            else if (log.transactionType === 'PAYMENT') badge = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded">THANH TOÁN NỢ</span>`;
            else badge = `<span class="bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 rounded">TRỪ NỢ HOÀN HÀNG</span>`;

            const sign = log.changeAmount > 0 ? '+' : '';
            const color = log.changeAmount > 0 ? 'text-red-600 font-black' : 'text-emerald-600 font-black';
            const safeNote = (log.note || '').replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 text-slate-500 whitespace-nowrap">${dStr}</td>
                    <td class="p-2.5">${badge} <b class="ml-1 text-slate-700">${log.referenceId || ''}</b></td>
                    <td class="p-2.5 text-slate-600">${log.note || ''}</td>
                    <td class="p-2.5 text-right text-slate-500 font-semibold">${formatmoney(log.beforeDebt)} đ</td>
                    <td class="p-2.5 text-right ${color}">${sign}${formatmoney(log.changeAmount)} đ</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${formatmoney(log.afterDebt)} đ</td>
                    <td class="p-2.5 text-center whitespace-nowrap">
                        <button onclick="editDebtLogEntry('${log.id}', ${log.changeAmount}, '${safeNote}')" title="Sửa số tiền / ghi chú" class="text-amber-600 hover:text-amber-800 px-1.5 py-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteDebtLogEntry('${log.id}', ${log.changeAmount})" title="Xóa dòng công nợ này" class="text-red-500 hover:text-red-700 px-1.5 py-1"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-red-500">Lỗi: ${e.message}</td></tr>`;
    }
}

// Sửa dòng lịch sử Sổ Ghi Nợ & Tự động cập nhật lại Tổng Dư Nợ hiện tại của khách
async function editDebtLogEntry(logId, oldChangeAmount, oldNote) {
    const c = customers.find(x => x.id === currentLedgerCustomerId);
    if (!c) return;

    const rawNewAmt = prompt(
        `Sửa số tiền phát sinh (Nhập số dương nếu tăng nợ, thêm dấu trừ "-" phía trước nếu trả nợ):`,
        oldChangeAmount
    );
    if (rawNewAmt === null) return;

    const isNegative = rawNewAmt.toString().trim().startsWith('-');
    const cleanNum = parseInt(rawNewAmt.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;
    const newChangeAmount = isNegative ? -cleanNum : cleanNum;

    const newNote = prompt("Sửa ghi chú diễn giải:", oldNote);
    if (newNote === null) return;

    const diff = newChangeAmount - oldChangeAmount;
    const newCurrentDebt = Math.max(0, (Number(c.currentDebt) || 0) + diff);

    try {
        const logRef = db.collection("debts").doc(logId);
        const logSnap = await logRef.get();
        if (logSnap.exists) {
            const logData = logSnap.data();
            const updatedAfter = Math.max(0, (Number(logData.beforeDebt) || 0) + newChangeAmount);
            await logRef.update({
                changeAmount: newChangeAmount,
                afterDebt: updatedAfter,
                note: newNote.trim()
            });
        }

        await db.collection("customers").doc(c.id).update({ currentDebt: newCurrentDebt, updatedAt: Date.now() });
        document.getElementById('dl-cust-summary').innerText = `SĐT: ${c.phone || '---'} • Dư nợ hiện tại: ${formatmoney(newCurrentDebt)} đ`;
        loadDebtLedgerLogs(c.id);
        alert("Đã cập nhật dòng công nợ và đồng bộ lại Tổng dư nợ!");
    } catch (e) {
        alert("Lỗi sửa công nợ: " + e.message);
    }
}

// Xóa dòng lịch sử Sổ Ghi Nợ
async function deleteDebtLogEntry(logId, changeAmount) {
    const c = customers.find(x => x.id === currentLedgerCustomerId);
    if (!c) return;
    if (!confirm("Bạn có chắc muốn xóa dòng lịch sử công nợ này?")) return;

    const revertDebt = confirm(
        `Bạn có muốn ĐẢO NGƯỢC số tiền (${changeAmount > 0 ? '-' : '+'}${formatmoney(Math.abs(changeAmount))}đ) vào Tổng dư nợ hiện tại của "${c.name}" không?\n\n` +
        `- Bấm [OK]: Vừa xóa dòng này, vừa cập nhật lại Tổng dư nợ.\n` +
        `- Bấm [Cancel]: Chỉ xóa dòng chữ lịch sử, giữ nguyên Tổng dư nợ hiện tại.`
    );

    try {
        if (revertDebt && changeAmount !== 0) {
            const newDebt = Math.max(0, (Number(c.currentDebt) || 0) - changeAmount);
            await db.collection("customers").doc(c.id).update({ currentDebt: newDebt, updatedAt: Date.now() });
            document.getElementById('dl-cust-summary').innerText = `SĐT: ${c.phone || '---'} • Dư nợ hiện tại: ${formatmoney(newDebt)} đ`;
        }
        await db.collection("debts").doc(logId).delete();
        loadDebtLedgerLogs(c.id);
    } catch (e) {
        alert("Lỗi xóa dòng công nợ: " + e.message);
    }
}

async function submitDebtPayment() {
    if (!currentLedgerCustomerId) return;
    const c = customers.find(x => x.id === currentLedgerCustomerId);
    if (!c) return;

    const payAmount = getRawNum('dl-pay-amount');
    const channel = document.getElementById('dl-pay-channel').value;
    const note = document.getElementById('dl-pay-note').value.trim() || "Thanh toán công nợ";

    if (payAmount <= 0) return alert("Vui lòng nhập số tiền thanh toán hợp lệ!");

    const beforeDebt = Number(c.currentDebt) || 0;
    const afterDebt = Math.max(0, beforeDebt - payAmount);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const voucherCode = `TN-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        await db.collection("customers").doc(c.id).update({ currentDebt: afterDebt, updatedAt: Date.now() });
        await db.collection("debts").add({
            customerId: c.id,
            customerName: c.name,
            ledgerType: c.type === 'SUPPLIER' ? 'PAYABLE' : 'RECEIVABLE',
            transactionType: "PAYMENT",
            referenceId: voucherCode,
            beforeDebt,
            changeAmount: -payAmount,
            afterDebt,
            note,
            createdAt: Date.now()
        });

        await db.collection("cashbook").add({
            voucherCode,
            type: c.type === 'SUPPLIER' ? 'EXPENSE' : 'INCOME',
            channel,
            category: "DEBT_PAY",
            amount: payAmount,
            referenceId: voucherCode,
            note: `${c.type === 'SUPPLIER' ? 'Trả nợ NCC' : 'Thu nợ khách'} ${c.name}: ${note}`,
            seller: document.getElementById('seller-name')?.value || "Chủ Quán",
            dateStr,
            createdAt: Date.now()
        });

        document.getElementById('dl-cust-summary').innerText = `SĐT: ${c.phone || '---'} • Dư nợ hiện tại: ${formatmoney(afterDebt)} đ`;
        document.getElementById('dl-pay-amount').value = '';
        loadDebtLedgerLogs(c.id);
        if (typeof loadCashbookModule === 'function') loadCashbookModule();
        alert(`Đã ghi nhận ${formatmoney(payAmount)}đ vào Sổ nợ & Sổ quỹ!`);
    } catch (e) {
        alert("Lỗi thanh toán nợ: " + e.message);
    }
}

// ==========================================
// XỬ LÝ TRẢ HÀNG / HOÀN HÀNG THÔNG MINH (ĐỒNG BỘ CẢ KHO, CÔNG NỢ, SỔ QUỸ TIỀN MẶT / CHUYỂN KHOẢN & LÃI LỖ)
// ==========================================
function openReturnOrderModalFromBill() {
    if (!currentViewingOrder) return;
    closeBillModal();
    openReturnOrderModal(currentViewingOrder);
}

function openReturnOrderModal(order) {
    currentViewingOrder = order;
    const cust = customers.find(c => c.id === order.customerId);
    const curDebt = cust ? (Number(cust.currentDebt) || 0) : 0;

    document.getElementById('ret-orig-code').innerText = order.orderCode;
    document.getElementById('ret-cust-name').innerText = order.customerSnapshot?.name || "Khách Lẻ";
    document.getElementById('ret-cust-debt').innerText = `${formatmoney(curDebt)} đ`;

    // TỰ ĐỘNG CHỌN PHƯƠNG THỨC HOÀN TIỀN THÔNG MINH THEO ĐƠN GỐC
   const refundModeSel = document.getElementById('ret-refund-mode');
    if (refundModeSel) {
        // Hễ khách đang có công nợ (> 0đ) thì mặc định ưu tiên Trừ trực tiếp vào Công nợ của khách
        if (curDebt > 0) {
            refundModeSel.value = 'DEBT_OFFSET';
        } else if (order.paymentMethod === 'BANK') {
            refundModeSel.value = 'BANK_REFUND';
        } else {
            refundModeSel.value = 'CASH_REFUND';
        }
    }

    const tbody = document.getElementById('ret-items-tbody');
    tbody.innerHTML = '';
    (order.items || []).forEach((item, idx) => {
        tbody.innerHTML += `
            <tr>
                <td class="p-2 text-center">
                    <input type="checkbox" data-idx="${idx}" onchange="onToggleReturnCheckbox(${idx}, this.checked)" class="ret-check-input w-4 h-4 accent-purple-600 cursor-pointer">
                </td>
                <td class="p-2 font-bold text-slate-800">${item.productName}<span class="block text-[10px] text-slate-400">Đơn giá: ${formatmoney(item.unitPrice)}đ/${item.unitName}</span></td>
                <td class="p-2 text-center font-semibold">${item.qty} ${item.unitName}</td>
                <td class="p-2 text-center">
                    <input type="number" id="ret-qty-${idx}" min="0" max="${item.qty}" value="0" data-idx="${idx}" oninput="onInputReturnQty(${idx})" class="ret-qty-input w-16 border-2 border-purple-400 rounded p-1 text-center font-black text-purple-700">
                </td>
                <td class="p-2 text-right font-bold text-slate-800" id="ret-line-total-${idx}">0 đ</td>
            </tr>
        `;
    });

    document.getElementById('ret-total-refund').innerText = "0 đ";
    document.getElementById('return-order-modal').classList.remove('hidden');
}

function onToggleReturnCheckbox(idx, checked) {
    const qtyInp = document.getElementById(`ret-qty-${idx}`);
    if (!qtyInp || !currentViewingOrder) return;
    const maxQty = currentViewingOrder.items[idx].qty;
    qtyInp.value = checked ? maxQty : 0;
    calcReturnModalTotal();
}

function onInputReturnQty(idx) {
    const qtyInp = document.getElementById(`ret-qty-${idx}`);
    const chk = document.querySelector(`.ret-check-input[data-idx="${idx}"]`);
    if (qtyInp && chk) {
        chk.checked = (parseInt(qtyInp.value, 10) || 0) > 0;
    }
    calcReturnModalTotal();
}

function closeReturnOrderModal() {
    document.getElementById('return-order-modal').classList.add('hidden');
}

function calcReturnModalTotal() {
    if (!currentViewingOrder) return 0;
    let totalRefund = 0;
    document.querySelectorAll('.ret-qty-input').forEach(inp => {
        const idx = parseInt(inp.getAttribute('data-idx'), 10);
        const item = currentViewingOrder.items[idx];
        let rQty = parseInt(inp.value, 10) || 0;
        if (rQty > item.qty) { rQty = item.qty; inp.value = rQty; }
        if (rQty < 0) { rQty = 0; inp.value = 0; }
        const lineVal = rQty * item.unitPrice;
        totalRefund += lineVal;
        const lineEl = document.getElementById(`ret-line-total-${idx}`);
        if (lineEl) lineEl.innerText = `${formatmoney(lineVal)} đ`;
    });
    document.getElementById('ret-total-refund').innerText = `${formatmoney(totalRefund)} đ`;
    return totalRefund;
}

async function submitReturnOrder() {
    if (!currentViewingOrder) return;
    const orig = currentViewingOrder;
    const returnItems = [];
    const remainingOrigItems = [];
    let totalRefund = 0;
    let totalCostRefund = 0;

    orig.items.forEach((origItem, idx) => {
        const inp = document.getElementById(`ret-qty-${idx}`);
        const rQty = inp ? (parseInt(inp.value, 10) || 0) : 0;

        if (rQty > 0) {
            const baseQty = rQty * origItem.conversionRate;
            const lineTotal = rQty * origItem.unitPrice;
            const lineCost = baseQty * (origItem.costPricePerBase || 0);
            totalRefund += lineTotal;
            totalCostRefund += lineCost;
            returnItems.push({
                ...origItem,
                qty: rQty,
                baseQty,
                totalPrice: lineTotal,
                totalCost: lineCost
            });
        }

        const leftQty = origItem.qty - rQty;
        if (leftQty > 0) {
            const leftBase = leftQty * origItem.conversionRate;
            remainingOrigItems.push({
                ...origItem,
                qty: leftQty,
                baseQty: leftBase,
                totalPrice: leftQty * origItem.unitPrice,
                totalCost: leftBase * (origItem.costPricePerBase || 0)
            });
        }
    });

    if (returnItems.length === 0) return alert("Vui lòng tick chọn và nhập số lượng trả lại lớn hơn 0 ở ít nhất 1 món hàng!");

    const refundMode = document.getElementById('ret-refund-mode').value;
    const reason = document.getElementById('ret-reason').value.trim() || "Hoàn hàng";
    const btn = document.getElementById('btn-submit-return');
    btn.disabled = true;
    btn.innerText = "Đang đồng bộ hoàn...";

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const retCode = `TH-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        const cust = customers.find(c => c.id === orig.customerId);
        const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;

        // Tính toán thông minh số tiền trừ nợ vs số tiền hoàn lại từ Sổ quỹ (Tiền mặt / Chuyển khoản)
        let debtOffsetAmount = 0;
        let cashbookRefundAmount = 0;
        let refundChannel = orig.paymentMethod === 'BANK' ? 'BANK' : 'CASH';

        if (refundMode === 'DEBT_OFFSET') {
            if (cust && oldDebt > 0) {
                debtOffsetAmount = Math.min(oldDebt, totalRefund);
                cashbookRefundAmount = totalRefund - debtOffsetAmount;
            } else {
                // Khách không có nợ (đã trả đủ bằng Tiền mặt hoặc Chuyển khoản lúc mua) -> Tự động trừ tiền trong Sổ quỹ!
                cashbookRefundAmount = totalRefund;
            }
        } else if (refundMode === 'BANK_REFUND') {
            cashbookRefundAmount = totalRefund;
            refundChannel = 'BANK';
        } else {
            cashbookRefundAmount = totalRefund;
            refundChannel = 'CASH';
        }

        const newDebt = Math.max(0, oldDebt - debtOffsetAmount);

        // 1. Cập nhật lại Hóa đơn gốc (Nếu trả hết sạch các món trong đơn thì cập nhật về 0đ)
        const updatedOrigTotal = remainingOrigItems.reduce((s, i) => s + i.totalPrice, 0);
        const updatedOrigCost = remainingOrigItems.reduce((s, i) => s + i.totalCost, 0);
        const updatedOrigPaid = Math.max(0, (orig.paidAmount || 0) - cashbookRefundAmount);
        const updatedOrigNewDebt = Math.max(0, (orig.oldDebt || 0) + updatedOrigTotal - updatedOrigPaid);

        await db.collection("orders").doc(orig.orderCode).update({
            items: remainingOrigItems,
            totalAmount: updatedOrigTotal,
            totalCost: updatedOrigCost,
            paidAmount: updatedOrigPaid,
            newDebt: updatedOrigNewDebt
        });

        // 2. Lưu phiếu hoàn hàng
        await db.collection("orders").doc(retCode).set({
            orderCode: retCode,
            orderType: "RETURN",
            originalOrderCode: orig.orderCode,
            customerId: orig.customerId,
            customerSnapshot: orig.customerSnapshot,
            seller: document.getElementById('seller-name')?.value || "Chủ Quán",
            items: returnItems,
            totalAmount: totalRefund,
            totalCost: totalCostRefund,
            oldDebt,
            paidAmount: cashbookRefundAmount,
            newDebt,
            paymentMethod: refundChannel,
            reason,
            dateStr,
            createdAt: Date.now()
        });

        // 3. Cộng lại số lượng vào Tồn kho & Ghi Thẻ kho
        for (const rItem of returnItems) {
            const dbProd = inventory.find(i => i.id === rItem.productId);
            if (dbProd) {
                const startStock = dbProd.stock;
                const endStock = startStock + rItem.baseQty;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(
                    dbProd.id, dbProd.name, "RETURN", `${retCode} (Từ ${orig.orderCode})`,
                    `Khách trả +${rItem.qty} ${rItem.unitName} (${rItem.baseQty} ${rItem.baseUnit})`,
                    startStock, rItem.baseQty, endStock
                );
            }
        }

        // 4. Trừ Công nợ khách hàng (Nếu có phần trừ nợ)
        if (cust && debtOffsetAmount > 0) {
            await db.collection("customers").doc(cust.id).update({ currentDebt: newDebt, updatedAt: Date.now() });
            await db.collection("debts").add({
                customerId: cust.id,
                customerName: cust.name,
                ledgerType: "RECEIVABLE",
                transactionType: "RETURN_OFFSET",
                referenceId: retCode,
                beforeDebt: oldDebt,
                changeAmount: -debtOffsetAmount,
                afterDebt: newDebt,
                note: `Trừ nợ hàng trả lại từ đơn ${orig.orderCode} (${reason})`,
                createdAt: Date.now()
            });
        }

        // 5. Đồng bộ Sổ Quỹ (Nếu khách đã thanh toán Tiền mặt / Chuyển khoản thì tự động trừ tiền khỏi Sổ Quỹ đúng kênh đó)
        if (cashbookRefundAmount > 0) {
            await db.collection("cashbook").add({
                voucherCode: "PH-" + retCode.split('-').pop(),
                type: "EXPENSE",
                channel: refundChannel,
                category: "REFUND",
                amount: cashbookRefundAmount,
                referenceId: orig.orderCode,
                note: `Hoàn tiền (${refundChannel === 'BANK' ? 'Chuyển khoản' : 'Tiền mặt'}) khách trả hàng đơn ${orig.orderCode} (${reason})`,
                seller: document.getElementById('seller-name')?.value || "Chủ Quán",
                dateStr,
                createdAt: Date.now()
            });
        }

        closeReturnOrderModal();
        loadOrdersModule();
        if (typeof loadCashbookModule === 'function') loadCashbookModule();
        if (typeof loadReportsModule === 'function') loadReportsModule();

        alert(
            `✅ Đã xử lý hoàn hàng đồng bộ 100%!\n` +
            `- Đã cộng lại hàng vào Kho & cập nhật lại Lãi/Lỗ.\n` +
            (debtOffsetAmount > 0 ? `- Đã trừ công nợ khách: -${formatmoney(debtOffsetAmount)}đ\n` : '') +
            (cashbookRefundAmount > 0 ? `- Đã trừ Sổ quỹ (${refundChannel === 'BANK' ? 'Chuyển khoản' : 'Tiền mặt'}): -${formatmoney(cashbookRefundAmount)}đ` : '')
        );
    } catch (e) {
        alert("Lỗi khi hoàn hàng: " + e.message);
    }

    btn.disabled = false;
    btn.innerText = "Xác Nhận Hoàn Hàng";
}

// ==========================================
// MODULE 5 & 6: SỔ QUỸ DÒNG TIỀN (CÓ SỬA / XÓA & TRỪ TIỀN HOÀN ĐƠN) + BÁO CÁO LÃI / LỖ
// ==========================================
async function loadCashbookModule() {
    const fromStr = document.getElementById('cb-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('cb-date-to')?.value || '2060-12-31';
    const tbody = document.getElementById('cb-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải sổ quỹ...</td></tr>`;

    try {
        const snap = await db.collection("cashbook")
            .where("dateStr", ">=", fromStr)
            .where("dateStr", "<=", toStr)
            .get();

        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
        tbody.innerHTML = '';

        let cashIn = 0, bankIn = 0, totalOut = 0;
        rows.forEach(r => {
            const amt = Number(r.amount) || 0;
            if (r.type === 'INCOME') {
                if (r.channel === 'BANK') bankIn += amt;
                else cashIn += amt;
            } else {
                // Nếu là phiếu hoàn tiền khách trả hàng (REFUND) -> Trừ trực tiếp vào Thu Tiền mặt / Thu Chuyển khoản để số thực thu không bị ảo!
                if (r.category === 'REFUND') {
                    if (r.channel === 'BANK') bankIn -= amt;
                    else cashIn -= amt;
                } else {
                    totalOut += amt;
                }
            }

            const dStr = new Date(r.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            const isIncome = r.type === 'INCOME';
            const isRefund = r.category === 'REFUND';
            const badge = isIncome 
                ? `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[10px] font-bold">PHIẾU THU</span>`
                : (isRefund 
                    ? `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded text-[10px] font-bold">HOÀN TIỀN KHÁCH</span>`
                    : `<span class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[10px] font-bold">PHIẾU CHI</span>`);
            const chanBadge = r.channel === 'BANK' ? `🏦 Chuyển khoản` : `💵 Tiền mặt`;
            const safeNote = (r.note || '').replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-3"><b class="text-slate-800">${r.voucherCode || ''}</b><span class="block text-xs text-slate-400">${dStr}</span></td>
                    <td class="p-3">${badge}</td>
                    <td class="p-3 font-semibold text-xs text-slate-600">${chanBadge}</td>
                    <td class="p-3 text-slate-700">${r.note || ''}</td>
                    <td class="p-3 text-right font-black ${isIncome ? 'text-emerald-600' : 'text-red-600'}">${isIncome ? '+' : '-'}${formatmoney(amt)} đ</td>
                    <td class="p-3 text-center whitespace-nowrap">
                        <button onclick="editCashbookEntry('${r.id}', ${amt}, '${r.channel}', '${safeNote}')" title="Sửa phiếu quỹ này" class="text-amber-600 hover:text-amber-800 px-1.5 py-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteCashbookEntry('${r.id}')" title="Xóa phiếu quỹ này" class="text-red-500 hover:text-red-700 px-1.5 py-1"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });

        document.getElementById('cb-stat-cash-in').innerText = `${formatmoney(cashIn)} đ`;
        document.getElementById('cb-stat-bank-in').innerText = `${formatmoney(bankIn)} đ`;
        document.getElementById('cb-stat-out').innerText = `${formatmoney(totalOut)} đ`;
        document.getElementById('cb-stat-net').innerText = `${formatmoney(cashIn + bankIn - totalOut)} đ`;

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 italic">Chưa có giao dịch thu/chi trong kỳ này.</td></tr>`;
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Lỗi tải sổ quỹ: ${e.message}</td></tr>`;
    }
}

// Sửa trực tiếp dòng Sổ Quỹ (Số tiền, Kênh Tiền mặt/Chuyển khoản, Ghi chú)
async function editCashbookEntry(docId, oldAmount, oldChannel, oldNote) {
    const rawAmt = prompt("Nhập số tiền mới (VNĐ):", oldAmount);
    if (rawAmt === null) return;
    const newAmount = parseInt(rawAmt.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;
    if (newAmount <= 0) return alert("Số tiền phải lớn hơn 0!");

    const newNote = prompt("Sửa lý do / diễn giải:", oldNote);
    if (newNote === null) return;

    const switchChannel = confirm(
        `Kênh hiện tại: ${oldChannel === 'BANK' ? 'CHUYỂN KHOẢN' : 'TIỀN MẶT'}.\n` +
        `- Bấm [OK] nếu muốn giữ nguyên kênh ${oldChannel === 'BANK' ? 'CHUYỂN KHOẢN' : 'TIỀN MẶT'}.\n` +
        `- Bấm [Cancel] nếu muốn đổi sang kênh ${oldChannel === 'BANK' ? 'TIỀN MẶT' : 'CHUYỂN KHOẢN'}.`
    );
    const newChannel = switchChannel ? oldChannel : (oldChannel === 'BANK' ? 'CASH' : 'BANK');

    try {
        await db.collection("cashbook").doc(docId).update({
            amount: newAmount,
            channel: newChannel,
            note: newNote.trim()
        });
        loadCashbookModule();
        alert("Đã cập nhật phiếu Sổ quỹ thành công!");
    } catch (e) {
        alert("Lỗi sửa Sổ quỹ: " + e.message);
    }
}

// Xóa dòng Sổ Quỹ bị nhập sai
async function deleteCashbookEntry(docId) {
    if (!confirm("Bạn có chắc chắn muốn XÓA phiếu Thu/Chi này khỏi Sổ quỹ?")) return;
    try {
        await db.collection("cashbook").doc(docId).delete();
        loadCashbookModule();
    } catch (e) {
        alert("Lỗi xóa phiếu Sổ quỹ: " + e.message);
    }
}

async function openVoucherModal(type) {
    const title = type === 'INCOME' ? 'Lập Phiếu Thu Tiền' : 'Lập Phiếu Chi (Điện, Nước, Vận chuyển...)';
    const rawAmt = prompt(`${title}\nNhập số tiền (VNĐ):`);
    if (!rawAmt) return;
    const amount = parseInt(rawAmt.replace(/\./g, '').replace(/\D/g, ''), 10) || 0;
    if (amount <= 0) return alert("Số tiền không hợp lệ!");

    const note = prompt("Nhập lý do Thu / Chi:", type === 'EXPENSE' ? "Chi phí điện nước / vận chuyển" : "Thu tiền khác") || "";
    const isBank = confirm("Bấm [OK] nếu giao dịch qua CHUYỂN KHOẢN NGÂN HÀNG.\nBấm [Cancel / Hủy] nếu giao dịch bằng TIỀN MẶT.");

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const voucherCode = `${type === 'INCOME' ? 'PT' : 'PC'}-${Math.floor(1000 + Math.random() * 9000)}`;

    await db.collection("cashbook").add({
        voucherCode,
        type,
        channel: isBank ? "BANK" : "CASH",
        category: "OPERATING",
        amount,
        referenceId: voucherCode,
        note,
        seller: document.getElementById('seller-name')?.value || "Chủ Quán",
        dateStr,
        createdAt: Date.now()
    });
    loadCashbookModule();
}

let activeReportCategoryTab = 'SALES';
let currentDetailedReportType = null;
let revenueReportSubMode = sessionStorage.getItem('hh_rev_dim') || 'DAY';
let profitReportSubMode = sessionStorage.getItem('hh_prof_dim') || 'DAY';
let detailedReportLimit = 40;
let reportSearchDebounce = null;
let expandedReportGroupKey = null;
let cachedReportOrdersByCode = {};

const REVENUE_DIMENSIONS = [
    { key: 'DAY', label: 'Doanh thu theo ngày' },
    { key: 'MONTH', label: 'Doanh thu theo tháng' },
    { key: 'YEAR', label: 'Doanh thu theo năm' },
    { key: 'ORDER', label: 'Doanh thu theo đơn hàng' },
    { key: 'CUSTOMER', label: 'Doanh thu theo khách hàng' },
    { key: 'CUST_GROUP', label: 'Doanh thu theo nhóm khách hàng' },
    { key: 'PRODUCT', label: 'Doanh thu theo sản phẩm' }
];

const PROFIT_DIMENSIONS = [
    { key: 'DAY', label: 'Lợi nhuận theo ngày' },
    { key: 'MONTH', label: 'Lợi nhuận theo tháng' },
    { key: 'YEAR', label: 'Lợi nhuận theo năm' },
    { key: 'ORDER', label: 'Lợi nhuận theo đơn hàng' },
    { key: 'CUSTOMER', label: 'Lợi nhuận theo khách hàng' },
    { key: 'CUST_GROUP', label: 'Lợi nhuận theo nhóm khách hàng' },
    { key: 'PRODUCT', label: 'Lợi nhuận theo sản phẩm' }
];

function getActiveMultiDimensionKey() {
    return currentDetailedReportType === 'SALES_PROFIT' ? profitReportSubMode : revenueReportSubMode;
}

function getActiveMultiDimensionList() {
    return currentDetailedReportType === 'SALES_PROFIT' ? PROFIT_DIMENSIONS : REVENUE_DIMENSIONS;
}

function syncReportDimensionHeaderLabel() {
    const lblEl = document.getElementById('dr-current-dim-label');
    if (!lblEl) return;
    const list = getActiveMultiDimensionList();
    const curKey = getActiveMultiDimensionKey();
    const found = list.find(x => x.key === curKey) || list[0];
    lblEl.innerText = found.label;
}

function openReportDimensionSheet() {
    const modal = document.getElementById('dr-dimension-sheet-modal');
    const listEl = document.getElementById('dr-dimension-options-list');
    const titleEl = document.getElementById('dr-sheet-title');
    if (!modal || !listEl) return;

    const isProfit = currentDetailedReportType === 'SALES_PROFIT';
    if (titleEl) titleEl.innerText = isProfit ? 'Chọn loại báo cáo lợi nhuận' : 'Chọn loại báo cáo doanh thu';

    const dims = getActiveMultiDimensionList();
    const curKey = getActiveMultiDimensionKey();

    listEl.innerHTML = dims.map(d => {
        const isSelected = d.key === curKey;
        return `
            <button type="button" onclick="selectReportDimension('${d.key}')" class="w-full px-4 py-3.5 flex items-center justify-between text-left active:bg-slate-50 transition ${isSelected ? 'bg-blue-50/50 font-bold text-[#0088FF]' : 'text-slate-700 font-medium'}">
                <span>${d.label}</span>
                ${isSelected ? `<span class="text-emerald-600 font-black text-base">✓</span>` : ''}
            </button>
        `;
    }).join('');

    modal.classList.remove('hidden');
}

function closeReportDimensionSheet() {
    document.getElementById('dr-dimension-sheet-modal')?.classList.add('hidden');
}

function selectReportDimension(dimKey) {
    if (currentDetailedReportType === 'SALES_PROFIT') {
        profitReportSubMode = dimKey;
        sessionStorage.setItem('hh_prof_dim', dimKey);
    } else {
        revenueReportSubMode = dimKey;
        sessionStorage.setItem('hh_rev_dim', dimKey);
    }
    expandedReportGroupKey = null;
    syncReportDimensionHeaderLabel();
    closeReportDimensionSheet();
    renderDetailedReportData(true);
}

function toggleReportGroupExpand(groupKey) {
    expandedReportGroupKey = (expandedReportGroupKey === groupKey) ? null : groupKey;
    renderDetailedReportData(false);
}

function openOrderFromReport(orderCode) {
    const ord = cachedReportOrdersByCode[orderCode];
    if (ord) openPrintableInvoice(ord);
}

function formatDateVN(yyyyMmDd) {
    if (!yyyyMmDd || !yyyyMmDd.includes('-')) return yyyyMmDd || '---';
    const [y, m, d] = yyyyMmDd.split('-');
    return `${d}/${m}/${y}`;
}

function isWholesaleOrderRecord(ord) {
    if (ord.customerSnapshot && ord.customerSnapshot.type === 'WHOLESALE') return true;
    if (ord.customerId && ord.customerId !== 'GUEST') {
        const c = customers.find(x => x.id === ord.customerId);
        if (c && c.type === 'WHOLESALE') return true;
    }
    return false;
}

function switchReportCategoryTab(cat) {
    activeReportCategoryTab = cat;
    ['SALES', 'INVENTORY', 'FINANCE'].forEach(c => {
        const grp = document.getElementById('rep-group-' + c);
        const btn = document.getElementById('rep-cat-btn-' + c);
        if (grp) grp.classList.toggle('hidden', c !== cat);
        if (btn) {
            btn.className = (c === cat)
                ? "border-b-2 border-white pb-1.5 font-bold text-white"
                : "text-blue-100 pb-1.5 font-semibold";
        }
    });
}

async function loadReportsModule() {
    switchReportCategoryTab(activeReportCategoryTab);
    const fromStr = document.getElementById('rep-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('rep-date-to')?.value || '2060-12-31';
    const tbody = document.getElementById('rep-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tính toán báo cáo...</td></tr>`;

    try {
        const snap = await db.collection("orders")
            .where("dateStr", ">=", fromStr)
            .where("dateStr", "<=", toStr)
            .get();

        const salesOrders = snap.docs.map(d => d.data()).filter(o => o.orderType === 'SALE' && o.status !== 'PROCESSING' && (Number(o.totalAmount) || 0) > 0);
        let netRev = 0, totalCost = 0;
        const itemMap = {};

        salesOrders.forEach(ord => {
            (ord.items || []).forEach(i => {
                if ((Number(i.qty) || 0) <= 0) return;
                const lineRev = Number(i.totalPrice) || 0;
                const lineCost = Number(i.totalCost) || 0;
                netRev += lineRev;
                totalCost += lineCost;

                if (!itemMap[i.productName]) {
                    itemMap[i.productName] = { baseUnit: i.baseUnit || 'ĐV', baseQty: 0, rev: 0, cost: 0 };
                }
                itemMap[i.productName].baseQty += Number(i.baseQty) || (Number(i.qty) * (Number(i.conversionRate) || 1)) || 0;
                itemMap[i.productName].rev += lineRev;
                itemMap[i.productName].cost += lineCost;
            });
        });

        const grossProfit = netRev - totalCost;
        document.getElementById('rep-stat-rev').innerText = `${formatmoney(netRev)} đ`;
        document.getElementById('rep-stat-cost').innerText = `${formatmoney(totalCost)} đ`;
        document.getElementById('rep-stat-profit').innerText = `${formatmoney(grossProfit)} đ`;
        document.getElementById('rep-stat-orders').innerText = `${salesOrders.length} đơn`;

        if (!tbody) return;
        const sortedNames = Object.keys(itemMap).sort((a, b) => (itemMap[b].rev - itemMap[b].cost) - (itemMap[a].rev - itemMap[a].cost));
        tbody.innerHTML = '';

        if (sortedNames.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 italic">Chưa có dữ liệu bán hàng trong kỳ này.</td></tr>`;
            return;
        }

        sortedNames.forEach(name => {
            const st = itemMap[name];
            const profit = st.rev - st.cost;
            const safeName = name.replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-3 font-bold text-slate-800">${name}</td>
                    <td class="p-3 text-center font-semibold">${st.baseQty} ${st.baseUnit}</td>
                    <td class="p-3 text-right font-bold text-inni-blue">${formatmoney(st.rev)} đ</td>
                    <td class="p-3 text-right text-slate-600">${formatmoney(st.cost)} đ</td>
                    <td class="p-3 text-right font-black ${profit >= 0 ? 'text-emerald-600' : 'text-red-600'}">${profit >= 0 ? '+' : ''}${formatmoney(profit)} đ</td>
                    <td class="p-3 text-center whitespace-nowrap">
                        <button onclick="editReportItem('${safeName}', ${st.baseQty}, ${st.rev}, ${st.cost})" class="text-amber-600 hover:text-amber-800 px-1.5 py-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteReportItem('${safeName}')" class="text-red-500 hover:text-red-700 px-1.5 py-1"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Lỗi báo cáo: ${e.message}</td></tr>`;
    }
}

function openDetailedReport(reportType) {
    currentDetailedReportType = reportType;
    detailedReportLimit = 40;
    expandedReportGroupKey = null;

    const repFrom = document.getElementById('rep-date-from')?.value || '';
    const repTo = document.getElementById('rep-date-to')?.value || '';
    const drFrom = document.getElementById('dr-date-from');
    const drTo = document.getElementById('dr-date-to');
    if (drFrom && repFrom) drFrom.value = repFrom;
    if (drTo && repTo) drTo.value = repTo;

    const searchInp = document.getElementById('dr-search-input');
    if (searchInp) searchInp.value = '';

    const titles = {
        'SALES_REVENUE': 'Báo cáo doanh thu',
        'SALES_PROFIT': 'Báo cáo lợi nhuận',
        'SALES_PAYMENT': 'Báo cáo phương thức thanh toán',
        'INV_VALUATION': 'Báo cáo giá trị tồn kho',
        'INV_LEDGER': 'Sổ kho — Lịch sử nhập/xuất',
        'INV_MOVEMENT': 'Báo cáo xuất nhập tồn',
        'INV_LOW_STOCK': 'Báo cáo hàng dưới định mức',
        'FIN_PNL': 'Báo cáo kết quả kinh doanh (Lãi/Lỗ)',
        'FIN_CASHBOOK': 'Báo cáo Sổ quỹ thu chi',
        'FIN_DEBT_CUST': 'Báo cáo công nợ Khách hàng',
        'FIN_DEBT_SUP': 'Báo cáo công nợ Nhà cung cấp'
    };
    document.getElementById('dr-title').innerText = titles[reportType] || 'Báo cáo chi tiết';

    const isMultiDimReport = (reportType === 'SALES_REVENUE' || reportType === 'SALES_PROFIT');
    document.getElementById('dr-submode-wrap').classList.toggle('hidden', !isMultiDimReport);
    if (isMultiDimReport) syncReportDimensionHeaderLabel();

    document.getElementById('dr-extra-filter').classList.toggle('hidden', reportType !== 'INV_LEDGER');
    document.getElementById('dr-date-filter-wrap').classList.toggle('hidden', ['INV_VALUATION', 'INV_LOW_STOCK'].includes(reportType));

    document.getElementById('detailed-report-modal').classList.remove('hidden');
    renderDetailedReportData(true);
}

function closeDetailedReport() {
    closeReportDimensionSheet();
    document.getElementById('detailed-report-modal').classList.add('hidden');
    switchReportCategoryTab(activeReportCategoryTab);
}

function onDebouncedReportSearch() {
    clearTimeout(reportSearchDebounce);
    reportSearchDebounce = setTimeout(() => renderDetailedReportData(true), 250);
}

function loadMoreDetailedReport() {
    detailedReportLimit += 40;
    renderDetailedReportData(false);
}

// Sinh danh sách chi tiết con khi người dùng bấm mở rộng (drill-down) 1 dòng báo cáo
function buildExpandedOrdersSubListHtml(ordersArr, isProfitMode, colSpan = 2, subGroupsHtml = '') {
    if ((!Array.isArray(ordersArr) || ordersArr.length === 0) && !subGroupsHtml) return '';
    const rows = (ordersArr || []).slice(0, 50).map(o => {
        const timeStr = new Date(o.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const cName = o.customerSnapshot?.name || 'Khách lẻ';
        const rev = Number(o.totalAmount) || 0;
        const cost = Number(o.totalCost) || 0;
        const prof = rev - cost;
        const margin = rev > 0 ? ((prof / rev) * 100).toFixed(2) + '%' : '—';

        const rightInfo = isProfitMode
            ? `<div class="text-right">
                   <div class="font-bold text-emerald-600 text-xs">Lãi: ${formatmoney(prof)} đ (${margin})</div>
                   <div class="text-[10.5px] text-slate-400">DT: ${formatmoney(rev)} đ • Vốn: ${formatmoney(cost)} đ</div>
               </div>`
            : `<div class="text-right font-bold text-[#0088FF] text-xs">${formatmoney(rev)} đ</div>`;

        return `
            <div onclick="openOrderFromReport('${o.orderCode}')" class="px-3 py-2 flex justify-between items-center bg-slate-50/90 hover:bg-blue-50/50 border-b border-slate-200/60 last:border-none cursor-pointer">
                <div>
                    <div class="font-bold text-[#0088FF] text-xs flex items-center gap-1.5">
                        <span>${o.orderCode}</span>
                        <span class="text-slate-600 font-normal">• ${cName}</span>
                    </div>
                    <div class="text-[10.5px] text-slate-400">${timeStr}</div>
                </div>
                ${rightInfo}
            </div>
        `;
    }).join('');

    return `
        <tr>
            <td colspan="${colSpan}" class="p-0 bg-slate-100/70">
                <div class="border-l-4 border-[#0088FF] divide-y divide-slate-200/60">
                    ${subGroupsHtml}
                    ${rows}
                </div>
            </td>
        </tr>
    `;
}

async function renderDetailedReportData(resetLimit = false) {
    if (resetLimit) detailedReportLimit = 40;
    const thead = document.getElementById('dr-thead');
    const tbody = document.getElementById('dr-tbody');
    const banner = document.getElementById('dr-summary-banner');
    const moreWrap = document.getElementById('dr-load-more-wrap');
    if (!thead || !tbody) return;

    const fromStr = document.getElementById('dr-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('dr-date-to')?.value || '2060-12-31';
    const fromTime = new Date(fromStr + 'T00:00:00').getTime();
    const toTime = new Date(toStr + 'T23:59:59.999').getTime();
    const kw = (document.getElementById('dr-search-input')?.value || '').toLowerCase().trim();

    tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang truy vấn dữ liệu thực tế...</td></tr>`;
    banner.innerHTML = '';
    if (moreWrap) moreWrap.classList.add('hidden');

    try {
        // ====================================================
        // 1 & 2. BÁO CÁO DOANH THU & BÁO CÁO LỢI NHUẬN ĐA CHIỀU (7 CHIỀU CHUẨN SAPO)
        // ====================================================
        if (currentDetailedReportType === 'SALES_REVENUE' || currentDetailedReportType === 'SALES_PROFIT') {
            const isProfitMode = (currentDetailedReportType === 'SALES_PROFIT');
            const dim = getActiveMultiDimensionKey();
            syncReportDimensionHeaderLabel();

            const snap = await db.collection("orders")
                .where("dateStr", ">=", fromStr)
                .where("dateStr", "<=", toStr)
                .get();

            cachedReportOrdersByCode = {};
            const validSalesOrders = [];
            let totalNetRevenue = 0;
            let totalCostOfGoods = 0;
            let totalReturnedVal = 0;
            let missingCostItemCount = 0;

            snap.docs.map(d => d.data()).forEach(o => {
                cachedReportOrdersByCode[o.orderCode] = o;
                if (o.status === 'PROCESSING') return; // Không tính đơn đang giao chưa hoàn tất vào doanh thu ghi nhận
                if (o.orderType === 'RETURN') {
                    totalReturnedVal += Number(o.totalAmount) || 0;
                    return;
                }
                if (o.orderType === 'SALE' && (Number(o.totalAmount) || 0) > 0) {
                    const rev = Number(o.totalAmount) || 0;
                    const cost = Number(o.totalCost) || 0;
                    (o.items || []).forEach(it => {
                        if (!it.isGift && (Number(it.qty) || 0) > 0 && (Number(it.totalCost) || 0) <= 0) {
                            missingCostItemCount++;
                        }
                    });
                    totalNetRevenue += rev;
                    totalCostOfGoods += cost;
                    validSalesOrders.push(o);
                }
            });

            validSalesOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const totalGrossProfit = totalNetRevenue - totalCostOfGoods;
            // Chuẩn nghiệp vụ: Tỷ suất LN = Tổng lợi nhuận gộp / Tổng doanh thu được ghi nhận * 100%
            const totalMarginStr = totalNetRevenue > 0
                ? ((totalGrossProfit / totalNetRevenue) * 100).toFixed(2) + '%'
                : '—';

            // MODULE 2: SUMMARY CARD PHONG CÁCH SAPO Ở ĐẦU TRANG
            if (!isProfitMode) {
                banner.innerHTML = `
                    <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 text-center flex flex-col items-center">
                        <div class="w-10 h-10 rounded-full bg-blue-50 text-[#0088FF] flex items-center justify-center text-base mb-1.5">
                            <i class="fa-solid fa-chart-column"></i>
                        </div>
                        <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">DOANH THU</div>
                        <div class="text-2xl font-black text-[#0088FF] mt-0.5">${formatmoney(totalNetRevenue)} đ</div>
                        <div class="text-xs font-semibold text-slate-500 mt-0.5">
                            Số đơn hàng: <b class="text-slate-800">${validSalesOrders.length}</b>
                            ${totalReturnedVal > 0 ? `<span class="text-slate-400 ml-1">(Hoàn trả đã trừ: ${formatmoney(totalReturnedVal)}đ)</span>` : ''}
                        </div>
                    </div>
                `;
            } else {
                banner.innerHTML = `
                    <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 text-center flex flex-col items-center">
                        <div class="w-10 h-10 rounded-full bg-blue-50 text-[#0088FF] flex items-center justify-center text-base mb-1.5">
                            <i class="fa-solid fa-coins"></i>
                        </div>
                        <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">LỢI NHUẬN GỘP</div>
                        <div class="text-2xl font-black text-[#0088FF] mt-0.5">${formatmoney(totalGrossProfit)} đ</div>
                        <div class="text-xs font-semibold text-slate-500 mt-0.5">
                            Tỷ suất LN: <b class="text-emerald-600">${totalMarginStr}</b>
                            <span class="text-slate-400 ml-1">(DT: ${formatmoney(totalNetRevenue)}đ • Giá vốn: ${formatmoney(totalCostOfGoods)}đ)</span>
                        </div>
                        ${missingCostItemCount > 0 ? `<div class="text-[10.5px] text-amber-600 font-semibold mt-1">Lưu ý: Có ${missingCostItemCount} dòng hàng chưa cập nhật giá vốn (0đ)</div>` : ''}
                    </div>
                `;
            }

            // CHIỀU 1, 2, 3: THEO NGÀY / THEO THÁNG / THEO NĂM
            if (dim === 'DAY' || dim === 'MONTH' || dim === 'YEAR') {
                const timeMap = {};
                validSalesOrders.forEach(o => {
                    const dStr = o.dateStr || '';
                    let key = dStr;
                    let label = formatDateVN(dStr);
                    if (dim === 'MONTH') {
                        key = dStr.slice(0, 7); // YYYY-MM
                        const [y, m] = key.split('-');
                        label = `${m}/${y}`;
                    } else if (dim === 'YEAR') {
                        key = dStr.slice(0, 4); // YYYY
                        label = `Năm ${key}`;
                    }
                    if (!timeMap[key]) timeMap[key] = { key, label, rev: 0, cost: 0, orders: [], subMap: {} };
                    const rev = Number(o.totalAmount) || 0;
                    const cost = Number(o.totalCost) || 0;
                    timeMap[key].rev += rev;
                    timeMap[key].cost += cost;
                    timeMap[key].orders.push(o);

                    // Lưu nhóm con (Tháng mở rộng ra Ngày; Năm mở rộng ra Tháng)
                    if (dim === 'MONTH') {
                        const dayLbl = formatDateVN(dStr);
                        if (!timeMap[key].subMap[dStr]) timeMap[key].subMap[dStr] = { label: dayLbl, rev: 0, cost: 0, count: 0 };
                        timeMap[key].subMap[dStr].rev += rev;
                        timeMap[key].subMap[dStr].cost += cost;
                        timeMap[key].subMap[dStr].count++;
                    } else if (dim === 'YEAR') {
                        const mKey = dStr.slice(0, 7);
                        const [yy, mm] = mKey.split('-');
                        const mLbl = `Tháng ${mm}/${yy}`;
                        if (!timeMap[key].subMap[mKey]) timeMap[key].subMap[mKey] = { label: mLbl, rev: 0, cost: 0, count: 0 };
                        timeMap[key].subMap[mKey].rev += rev;
                        timeMap[key].subMap[mKey].cost += cost;
                        timeMap[key].subMap[mKey].count++;
                    }
                });

                const keys = Object.keys(timeMap)
                    .filter(k => !kw || timeMap[k].label.toLowerCase().includes(kw))
                    .sort((a, b) => b.localeCompare(a));

                const colTitle = dim === 'DAY' ? 'Ngày' : (dim === 'MONTH' ? 'Tháng/Năm' : 'Năm');
                const valTitle = isProfitMode ? 'Tổng lợi nhuận gộp' : 'Tổng doanh thu';
                thead.innerHTML = `<tr><th class="p-3">${colTitle}</th><th class="p-3 text-right">${valTitle}</th></tr>`;

                if (keys.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="2" class="p-8 text-center text-slate-400 italic">Không có dữ liệu trong khoảng thời gian này.</td></tr>`;
                    return;
                }

                tbody.innerHTML = keys.slice(0, detailedReportLimit).map(k => {
                    const g = timeMap[k];
                    const prof = g.rev - g.cost;
                    const margin = g.rev > 0 ? ((prof / g.rev) * 100).toFixed(2) + '%' : '—';
                    const isExp = expandedReportGroupKey === k;

                    const rightCell = isProfitMode
                        ? `<div class="font-black text-sm ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">${formatmoney(prof)} đ</div>
                           <div class="text-[11px] text-slate-400">DT: ${formatmoney(g.rev)}đ • Tỷ suất: <b class="text-[#0088FF]">${margin}</b></div>`
                        : `<div class="font-black text-sm text-slate-800">${formatmoney(g.rev)} đ</div>
                           <div class="text-[11px] text-slate-400">${g.orders.length} đơn hàng</div>`;

                    let subBreakdownHtml = '';
                    if (isExp && Object.keys(g.subMap).length > 0) {
                        subBreakdownHtml = Object.keys(g.subMap).sort((a, b) => b.localeCompare(a)).map(sk => {
                            const sr = g.subMap[sk];
                            const sProf = sr.rev - sr.cost;
                            const sMargin = sr.rev > 0 ? ((sProf / sr.rev) * 100).toFixed(1) + '%' : '—';
                            return `<div class="px-3 py-1.5 bg-blue-50/60 flex justify-between items-center text-[11px] font-semibold text-slate-700">
                                <span>• ${sr.label} (${sr.count} đơn)</span>
                                <span>${isProfitMode ? `Lãi: ${formatmoney(sProf)}đ (${sMargin})` : `DT: ${formatmoney(sr.rev)}đ`}</span>
                            </div>`;
                        }).join('');
                    }

                    return `
                        <tr onclick="toggleReportGroupExpand('${k}')" class="cursor-pointer hover:bg-slate-50 active:bg-slate-100">
                            <td class="p-3 font-bold text-slate-800">
                                <i class="fa-solid fa-chevron-${isExp ? 'down' : 'right'} text-[10px] text-slate-400 mr-1.5"></i>${g.label}
                            </td>
                            <td class="p-3 text-right">${rightCell}</td>
                        </tr>
                        ${isExp ? buildExpandedOrdersSubListHtml(g.orders, isProfitMode, 2, subBreakdownHtml) : ''}
                    `;
                }).join('');

                if (moreWrap) moreWrap.classList.toggle('hidden', keys.length <= detailedReportLimit);
                return;
            }

            // CHIỀU 4: THEO ĐƠN HÀNG
            if (dim === 'ORDER') {
                const filteredOrders = validSalesOrders.filter(o => {
                    if (!kw) return true;
                    const cName = (o.customerSnapshot?.name || 'Khách lẻ').toLowerCase();
                    return o.orderCode.toLowerCase().includes(kw) || cName.includes(kw);
                });

                thead.innerHTML = `<tr><th class="p-3">Đơn hàng / Khách hàng</th><th class="p-3 text-right">${isProfitMode ? 'Lãi gộp & Tỷ suất' : 'Doanh thu đơn'}</th></tr>`;
                if (filteredOrders.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="2" class="p-8 text-center text-slate-400 italic">Không có đơn hàng nào khớp.</td></tr>`;
                    return;
                }

                tbody.innerHTML = filteredOrders.slice(0, detailedReportLimit).map(o => {
                    const timeStr = new Date(o.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                    const cName = o.customerSnapshot?.name || 'Khách lẻ';
                    const rev = Number(o.totalAmount) || 0;
                    const cost = Number(o.totalCost) || 0;
                    const prof = rev - cost;
                    const margin = rev > 0 ? ((prof / rev) * 100).toFixed(2) + '%' : '—';
                    const paid = Number(o.paidAmount) || 0;
                    const payNote = paid < rev ? ` <span class="text-amber-600">(Đã thu: ${formatmoney(paid)}đ)</span>` : '';

                    const rightCell = isProfitMode
                        ? `<div class="font-black text-sm ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">${formatmoney(prof)} đ</div>
                           <div class="text-[11px] text-slate-400">DT: ${formatmoney(rev)}đ • Tỷ suất: <b class="text-[#0088FF]">${margin}</b></div>`
                        : `<div class="font-black text-sm text-[#0088FF]">${formatmoney(rev)} đ</div>
                           <div class="text-[10.5px] text-slate-400">Giá vốn: ${formatmoney(cost)}đ${payNote}</div>`;

                    return `
                        <tr onclick="openOrderFromReport('${o.orderCode}')" class="cursor-pointer hover:bg-slate-50 active:bg-slate-100">
                            <td class="p-3">
                                <div class="font-bold text-slate-800 text-xs">${o.orderCode}</div>
                                <div class="text-xs text-slate-600 mt-0.5">${cName}</div>
                                <div class="text-[10.5px] text-slate-400">${timeStr}</div>
                            </td>
                            <td class="p-3 text-right">${rightCell}</td>
                        </tr>
                    `;
                }).join('');

                if (moreWrap) moreWrap.classList.toggle('hidden', filteredOrders.length <= detailedReportLimit);
                return;
            }

            // CHIỀU 5: THEO KHÁCH HÀNG
            if (dim === 'CUSTOMER') {
                const custMap = {};
                validSalesOrders.forEach(o => {
                    const isGuest = !o.customerId || o.customerId === 'GUEST';
                    const cKey = isGuest ? 'GUEST_UNIDENTIFIED' : o.customerId;
                    const cName = isGuest ? 'Khách lẻ (Không định danh)' : (o.customerSnapshot?.name || 'Khách hàng');

                    if (!custMap[cKey]) custMap[cKey] = { key: cKey, name: cName, rev: 0, cost: 0, orders: [] };
                    custMap[cKey].rev += Number(o.totalAmount) || 0;
                    custMap[cKey].cost += Number(o.totalCost) || 0;
                    custMap[cKey].orders.push(o);
                });

                const keys = Object.keys(custMap)
                    .filter(k => !kw || custMap[k].name.toLowerCase().includes(kw))
                    .sort((a, b) => isProfitMode
                        ? ((custMap[b].rev - custMap[b].cost) - (custMap[a].rev - custMap[a].cost))
                        : (custMap[b].rev - custMap[a].rev));

                thead.innerHTML = `<tr><th class="p-3">Khách hàng</th><th class="p-3 text-center">Số đơn</th><th class="p-3 text-right">${isProfitMode ? 'Lãi gộp & Tỷ suất' : 'Tổng doanh thu'}</th></tr>`;

                tbody.innerHTML = keys.slice(0, detailedReportLimit).map(k => {
                    const c = custMap[k];
                    const prof = c.rev - c.cost;
                    // Tỷ suất lợi nhuận của khách = Tổng lợi nhuận gộp của khách / Tổng doanh thu của khách * 100%
                    const margin = c.rev > 0 ? ((prof / c.rev) * 100).toFixed(2) + '%' : '—';
                    const isExp = expandedReportGroupKey === k;

                    const rightCell = isProfitMode
                        ? `<div class="font-black text-sm ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">${formatmoney(prof)} đ</div>
                           <div class="text-[11px] text-slate-400">DT: ${formatmoney(c.rev)}đ • LN: <b class="text-[#0088FF]">${margin}</b></div>`
                        : `<div class="font-black text-sm text-[#0088FF]">${formatmoney(c.rev)} đ</div>`;

                    return `
                        <tr onclick="toggleReportGroupExpand('${k}')" class="cursor-pointer hover:bg-slate-50 active:bg-slate-100">
                            <td class="p-3 font-bold text-slate-800">
                                <i class="fa-solid fa-chevron-${isExp ? 'down' : 'right'} text-[10px] text-slate-400 mr-1.5"></i>${c.name}
                            </td>
                            <td class="p-3 text-center font-semibold">${c.orders.length} đơn</td>
                            <td class="p-3 text-right">${rightCell}</td>
                        </tr>
                        ${isExp ? buildExpandedOrdersSubListHtml(c.orders, isProfitMode, 3) : ''}
                    `;
                }).join('') || `<tr><td colspan="3" class="p-8 text-center text-slate-400 italic">Không có dữ liệu khách hàng.</td></tr>`;

                if (moreWrap) moreWrap.classList.toggle('hidden', keys.length <= detailedReportLimit);
                return;
            }

            // CHIỀU 6: THEO NHÓM KHÁCH HÀNG (TỆP KHÁCH SỈ vs TỆP KHÁCH LẺ)
            if (dim === 'CUST_GROUP') {
                const groups = {
                    WHOLESALE: { key: 'WHOLESALE', name: 'Tệp Khách Sỉ', rev: 0, cost: 0, orders: [] },
                    RETAIL: { key: 'RETAIL', name: 'Tệp Khách Lẻ', rev: 0, cost: 0, orders: [] }
                };

                validSalesOrders.forEach(o => {
                    const gKey = isWholesaleOrderRecord(o) ? 'WHOLESALE' : 'RETAIL';
                    groups[gKey].rev += Number(o.totalAmount) || 0;
                    groups[gKey].cost += Number(o.totalCost) || 0;
                    groups[gKey].orders.push(o);
                });

                thead.innerHTML = `<tr><th class="p-3">Nhóm khách hàng</th><th class="p-3 text-center">Số đơn</th><th class="p-3 text-right">${isProfitMode ? 'Doanh thu / Vốn / Lãi gộp' : 'Tổng doanh thu'}</th></tr>`;

                tbody.innerHTML = ['WHOLESALE', 'RETAIL'].map(k => {
                    const g = groups[k];
                    const prof = g.rev - g.cost;
                    const margin = g.rev > 0 ? ((prof / g.rev) * 100).toFixed(2) + '%' : '—';
                    const isExp = expandedReportGroupKey === k;

                    const rightCell = isProfitMode
                        ? `<div class="font-black text-sm ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">Lãi: ${formatmoney(prof)} đ (${margin})</div>
                           <div class="text-[11px] text-slate-500">DT: ${formatmoney(g.rev)}đ • Giá vốn: ${formatmoney(g.cost)}đ</div>`
                        : `<div class="font-black text-sm text-[#0088FF]">${formatmoney(g.rev)} đ</div>`;

                    return `
                        <tr onclick="toggleReportGroupExpand('${k}')" class="cursor-pointer hover:bg-slate-50 active:bg-slate-100">
                            <td class="p-3 font-bold text-slate-800">
                                <i class="fa-solid fa-chevron-${isExp ? 'down' : 'right'} text-[10px] text-slate-400 mr-1.5"></i>${g.name}
                            </td>
                            <td class="p-3 text-center font-semibold">${g.orders.length} đơn</td>
                            <td class="p-3 text-right">${rightCell}</td>
                        </tr>
                        ${isExp ? buildExpandedOrdersSubListHtml(g.orders, isProfitMode, 3) : ''}
                    `;
                }).join('');
                return;
            }

            // CHIỀU 7: THEO SẢN PHẨM (QUY ĐỔI ĐÚNG ĐƠN VỊ CƠ SỞ & MỞ RỘNG ĐƠN LIÊN QUAN)
            if (dim === 'PRODUCT') {
                const prodMap = {};
                validSalesOrders.forEach(o => {
                    (o.items || []).forEach(i => {
                        const rawQty = Number(i.qty) || 0;
                        if (rawQty <= 0) return;
                        const rate = Number(i.conversionRate) || 1;
                        const baseQty = Number(i.baseQty) || (rawQty * rate);
                        const rev = Number(i.totalPrice) || 0;
                        const cost = Number(i.totalCost) || 0;
                        const pKey = i.productId || i.productName;

                        if (!prodMap[pKey]) {
                            const invItem = inventory.find(x => x.id === i.productId || x.name === i.productName);
                            prodMap[pKey] = {
                                key: pKey,
                                name: i.productName,
                                sku: invItem?.barcode || '',
                                baseUnit: i.baseUnit || invItem?.baseUnit || i.unitName || 'ĐV',
                                baseQty: 0,
                                rev: 0,
                                cost: 0,
                                ordersMap: {}
                            };
                        }
                        prodMap[pKey].baseQty += baseQty;
                        prodMap[pKey].rev += rev;
                        prodMap[pKey].cost += cost;
                        prodMap[pKey].ordersMap[o.orderCode] = o;
                    });
                });

                const keys = Object.keys(prodMap)
                    .filter(k => !kw || prodMap[k].name.toLowerCase().includes(kw) || (prodMap[k].sku && prodMap[k].sku.toLowerCase().includes(kw)))
                    .sort((a, b) => isProfitMode
                        ? ((prodMap[b].rev - prodMap[b].cost) - (prodMap[a].rev - prodMap[a].cost))
                        : (prodMap[b].rev - prodMap[a].rev));

                thead.innerHTML = `<tr><th class="p-3">Sản phẩm</th><th class="p-3 text-center">SL Bán</th><th class="p-3 text-right">${isProfitMode ? 'Lãi gộp & Tỷ suất' : 'Tổng doanh thu'}</th></tr>`;

                tbody.innerHTML = keys.slice(0, detailedReportLimit).map((k, idx) => {
                    const p = prodMap[k];
                    const prof = p.rev - p.cost;
                    const margin = p.rev > 0 ? ((prof / p.rev) * 100).toFixed(2) + '%' : '—';
                    const safeKey = 'PROD_' + idx;
                    const isExp = expandedReportGroupKey === safeKey;
                    const relatedOrders = Object.values(p.ordersMap);

                    const rightCell = isProfitMode
                        ? `<div class="font-black text-sm ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">${formatmoney(prof)} đ (${margin})</div>
                           <div class="text-[10.5px] text-slate-400">DT: ${formatmoney(p.rev)}đ • Giá vốn: ${formatmoney(p.cost)}đ</div>`
                        : `<div class="font-black text-sm text-[#0088FF]">${formatmoney(p.rev)} đ</div>`;

                    return `
                        <tr onclick="toggleReportGroupExpand('${safeKey}')" class="cursor-pointer hover:bg-slate-50 active:bg-slate-100">
                            <td class="p-3">
                                <div class="font-bold text-slate-800 text-xs">
                                    <i class="fa-solid fa-chevron-${isExp ? 'down' : 'right'} text-[10px] text-slate-400 mr-1"></i>${p.name}
                                </div>
                                ${p.sku ? `<div class="text-[10.5px] text-slate-400 ml-3">SKU: ${p.sku}</div>` : ''}
                            </td>
                            <td class="p-3 text-center font-semibold text-xs">${formatmoney(p.baseQty)} ${p.baseUnit}</td>
                            <td class="p-3 text-right">${rightCell}</td>
                        </tr>
                        ${isExp ? buildExpandedOrdersSubListHtml(relatedOrders, isProfitMode, 3) : ''}
                    `;
                }).join('') || `<tr><td colspan="3" class="p-8 text-center text-slate-400 italic">Không có dữ liệu sản phẩm.</td></tr>`;

                if (moreWrap) moreWrap.classList.toggle('hidden', keys.length <= detailedReportLimit);
                return;
            }
        }

        // 2. BÁO CÁO LỢI NHUẬN GỘP & TỶ SUẤT LÃI (%)
        if (currentDetailedReportType === 'SALES_PROFIT') {
            const snap = await db.collection("orders").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get();
            const itemMap = {};
            let sumRev = 0, sumCost = 0;

            snap.docs.map(d => d.data()).forEach(o => {
                if (o.orderType !== 'SALE' || o.status === 'PROCESSING' || (Number(o.totalAmount) || 0) <= 0) return;
                (o.items || []).forEach(i => {
                    if ((Number(i.qty) || 0) <= 0) return;
                    const rev = Number(i.totalPrice) || 0;
                    const cost = Number(i.totalCost) || 0;
                    sumRev += rev;
                    sumCost += cost;
                    if (!itemMap[i.productName]) itemMap[i.productName] = { unit: i.baseUnit || 'ĐV', qty: 0, rev: 0, cost: 0 };
                    itemMap[i.productName].qty += Number(i.baseQty || i.qty) || 0;
                    itemMap[i.productName].rev += rev;
                    itemMap[i.productName].cost += cost;
                });
            });

            const sumProfit = sumRev - sumCost;
            const avgMargin = sumRev > 0 ? ((sumProfit / sumRev) * 100).toFixed(1) : "0.0";
            banner.innerHTML = `
                <div class="bg-white p-3 rounded-xl border border-slate-200 flex justify-between items-center text-xs">
                    <div>Tổng lãi gộp: <b class="text-emerald-600 text-sm">${formatmoney(sumProfit)} đ</b></div>
                    <div>Tỷ suất lãi TB: <b class="text-[#0088FF] text-sm">${avgMargin}%</b></div>
                </div>`;

            thead.innerHTML = `<tr><th class="p-2.5">Mặt hàng</th><th class="p-2.5 text-center">SL Bán</th><th class="p-2.5 text-right">Doanh thu</th><th class="p-2.5 text-right">Tổng giá vốn</th><th class="p-2.5 text-right">Lãi gộp</th><th class="p-2.5 text-right">Tỷ suất (%)</th></tr>`;
            const names = Object.keys(itemMap).filter(n => !kw || n.toLowerCase().includes(kw)).sort((a, b) => (itemMap[b].rev - itemMap[b].cost) - (itemMap[a].rev - itemMap[a].cost));
            tbody.innerHTML = names.slice(0, detailedReportLimit).map(n => {
                const r = itemMap[n];
                const prof = r.rev - r.cost;
                const margin = r.rev > 0 ? ((prof / r.rev) * 100).toFixed(1) + '%' : '0%';
                return `<tr>
                    <td class="p-2.5 font-bold text-slate-800">${n}</td>
                    <td class="p-2.5 text-center">${r.qty} ${r.unit}</td>
                    <td class="p-2.5 text-right font-semibold">${formatmoney(r.rev)} đ</td>
                    <td class="p-2.5 text-right text-slate-500">${formatmoney(r.cost)} đ</td>
                    <td class="p-2.5 text-right font-bold ${prof >= 0 ? 'text-emerald-600' : 'text-red-600'}">${formatmoney(prof)} đ</td>
                    <td class="p-2.5 text-right font-bold text-[#0088FF]">${margin}</td>
                </tr>`;
            }).join('') || `<tr><td colspan="6" class="p-6 text-center text-slate-400">Chưa có dữ liệu</td></tr>`;
            if (moreWrap) moreWrap.classList.toggle('hidden', names.length <= detailedReportLimit);
            return;
        }

        // 3. BÁO CÁO PHƯƠNG THỨC THANH TOÁN
        if (currentDetailedReportType === 'SALES_PAYMENT') {
            const snap = await db.collection("orders").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get();
            const stats = {
                CASH: { label: 'Tiền mặt (Đã thực thu)', count: 0, amount: 0 },
                BANK: { label: 'Chuyển khoản (Đã thực thu)', count: 0, amount: 0 },
                DEBT: { label: 'Ghi nợ phát sinh từ đơn hàng', count: 0, amount: 0 }
            };

            snap.docs.map(d => d.data()).forEach(o => {
                if (o.orderType !== 'SALE' || o.status === 'PROCESSING') return;
                const paid = Number(o.paidAmount) || 0;
                const debtAdded = Math.max(0, (Number(o.totalAmount) || 0) - paid);
                if (paid > 0) {
                    if (o.paymentMethod === 'BANK') { stats.BANK.count++; stats.BANK.amount += paid; }
                    else { stats.CASH.count++; stats.CASH.amount += paid; }
                }
                if (debtAdded > 0) {
                    stats.DEBT.count++;
                    stats.DEBT.amount += debtAdded;
                }
            });

            thead.innerHTML = `<tr><th class="p-3">Phương thức</th><th class="p-3 text-center">Số giao dịch</th><th class="p-3 text-right">Tổng tiền</th></tr>`;
            tbody.innerHTML = Object.values(stats).map(s => `
                <tr>
                    <td class="p-3 font-bold text-slate-800">${s.label}</td>
                    <td class="p-3 text-center font-semibold">${s.count}</td>
                    <td class="p-3 text-right font-black text-[#0088FF]">${formatmoney(s.amount)} đ</td>
                </tr>
            `).join('');
            return;
        }

        // 4. BÁO CÁO TỒN KHO
        if (currentDetailedReportType === 'INV_VALUATION') {
            let totalCap = 0;
            const filtered = inventory.filter(i => {
                if (i.stock > 0) totalCap += i.stock * i.costPrice;
                return !kw || i.name.toLowerCase().includes(kw) || (i.barcode && i.barcode.toLowerCase().includes(kw));
            });

            banner.innerHTML = `<div class="bg-white p-3.5 rounded-xl border border-slate-200 flex justify-between items-center text-xs"><span class="font-bold text-slate-600">Tổng giá trị tồn kho (Tồn × Giá vốn):</span><span class="font-black text-base text-[#0088FF]">${formatmoney(totalCap)} đ</span></div>`;
            thead.innerHTML = `<tr><th class="p-2.5">Tên mặt hàng</th><th class="p-2.5 text-center">ĐVT</th><th class="p-2.5 text-right">Tồn hiện tại</th><th class="p-2.5 text-right">Giá vốn</th><th class="p-2.5 text-right">Tổng giá trị tồn</th></tr>`;
            tbody.innerHTML = filtered.slice(0, detailedReportLimit).map(i => `
                <tr>
                    <td class="p-2.5 font-bold text-slate-800">${i.name}</td>
                    <td class="p-2.5 text-center">${i.baseUnit}</td>
                    <td class="p-2.5 text-right font-bold ${i.stock <= 0 ? 'text-red-600' : 'text-slate-800'}">${i.stock}</td>
                    <td class="p-2.5 text-right">${formatmoney(i.costPrice)} đ</td>
                    <td class="p-2.5 text-right font-black text-[#0088FF]">${formatmoney(Math.max(0, i.stock) * i.costPrice)} đ</td>
                </tr>
            `).join('');
            if (moreWrap) moreWrap.classList.toggle('hidden', filtered.length <= detailedReportLimit);
            return;
        }

        // 5. SỔ KHO — LỊCH SỬ NHẬP/XUẤT
        if (currentDetailedReportType === 'INV_LEDGER') {
            const typeFilter = document.getElementById('dr-extra-filter')?.value || 'ALL';
            const snap = await db.collection("inventory_logs")
                .where("createdAt", ">=", fromTime)
                .where("createdAt", "<=", toTime)
                .get();

            const logs = snap.docs.map(d => d.data())
                .filter(l => (typeFilter === 'ALL' || l.actionType === typeFilter) && (!kw || (l.productName || '').toLowerCase().includes(kw) || (l.referenceId || '').toLowerCase().includes(kw)))
                .sort((a, b) => b.createdAt - a.createdAt);

            thead.innerHTML = `<tr><th class="p-2.5">Thời gian</th><th class="p-2.5">Mã chứng từ</th><th class="p-2.5">Loại</th><th class="p-2.5">Tên hàng</th><th class="p-2.5 text-right">SL thay đổi</th><th class="p-2.5 text-right">Tồn cuối</th></tr>`;
            tbody.innerHTML = logs.slice(0, detailedReportLimit).map(l => {
                const dStr = new Date(l.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                const sign = l.changeQty > 0 ? '+' : '';
                return `<tr>
                    <td class="p-2.5 text-slate-500 whitespace-nowrap">${dStr}</td>
                    <td class="p-2.5 font-bold text-slate-700">${l.referenceId || '---'}</td>
                    <td class="p-2.5">${l.actionType || ''}</td>
                    <td class="p-2.5 font-bold text-slate-800">${l.productName || ''}</td>
                    <td class="p-2.5 text-right font-bold ${l.changeQty >= 0 ? 'text-emerald-600' : 'text-red-600'}">${sign}${l.changeQty}</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${l.endStock}</td>
                </tr>`;
            }).join('') || `<tr><td colspan="6" class="p-6 text-center text-slate-400">Chưa có biến động kho trong kỳ</td></tr>`;
            if (moreWrap) moreWrap.classList.toggle('hidden', logs.length <= detailedReportLimit);
            return;
        }

        // 6. BÁO CÁO XUẤT NHẬP TỒN (Tồn cuối = Tồn đầu + Nhập - Xuất)
        if (currentDetailedReportType === 'INV_MOVEMENT') {
            const snap = await db.collection("inventory_logs").where("createdAt", ">=", fromTime).get();
            const allRecentLogs = snap.docs.map(d => d.data());

            thead.innerHTML = `<tr><th class="p-2.5">Tên hàng</th><th class="p-2.5 text-right">Tồn đầu kỳ</th><th class="p-2.5 text-right">SL Nhập</th><th class="p-2.5 text-right">SL Xuất</th><th class="p-2.5 text-right">Tồn cuối kỳ</th></tr>`;
            const filteredProds = inventory.filter(i => !kw || i.name.toLowerCase().includes(kw));

            tbody.innerHTML = filteredProds.slice(0, detailedReportLimit).map(prod => {
                let changeAfterTo = 0;
                let inPeriodImport = 0;
                let inPeriodExport = 0;

                allRecentLogs.forEach(l => {
                    if (l.productId !== prod.id) return;
                    const chg = Number(l.changeQty) || 0;
                    if (l.createdAt > toTime) {
                        changeAfterTo += chg;
                    } else if (l.createdAt >= fromTime && l.createdAt <= toTime) {
                        if (chg > 0) inPeriodImport += chg;
                        else if (chg < 0) inPeriodExport += Math.abs(chg);
                    }
                });

                const closingStock = prod.stock - changeAfterTo;
                const openingStock = closingStock - inPeriodImport + inPeriodExport;

                return `<tr>
                    <td class="p-2.5 font-bold text-slate-800">${prod.name} <span class="text-[10px] text-slate-400 font-normal">(${prod.baseUnit})</span></td>
                    <td class="p-2.5 text-right font-semibold">${openingStock}</td>
                    <td class="p-2.5 text-right text-emerald-600 font-bold">+${inPeriodImport}</td>
                    <td class="p-2.5 text-right text-red-600 font-bold">-${inPeriodExport}</td>
                    <td class="p-2.5 text-right font-black text-[#0088FF]">${closingStock}</td>
                </tr>`;
            }).join('');
            if (moreWrap) moreWrap.classList.toggle('hidden', filteredProds.length <= detailedReportLimit);
            return;
        }

        // 7. BÁO CÁO DƯỚI ĐỊNH MỨC (Tồn hiện tại <= Định mức tối thiểu)
        if (currentDetailedReportType === 'INV_LOW_STOCK') {
            const lowItems = inventory.filter(i => i.stock <= i.minStock && (!kw || i.name.toLowerCase().includes(kw)));
            thead.innerHTML = `<tr><th class="p-2.5">Tên hàng</th><th class="p-2.5">Mã SKU</th><th class="p-2.5 text-center">ĐVT</th><th class="p-2.5 text-right">Tồn hiện tại</th><th class="p-2.5 text-right">Định mức tối thiểu</th></tr>`;
            tbody.innerHTML = lowItems.slice(0, detailedReportLimit).map(i => `
                <tr>
                    <td class="p-2.5 font-bold text-slate-800">${i.name}</td>
                    <td class="p-2.5 text-slate-500">${i.barcode || '---'}</td>
                    <td class="p-2.5 text-center">${i.baseUnit}</td>
                    <td class="p-2.5 text-right font-black text-red-600">${i.stock}</td>
                    <td class="p-2.5 text-right font-semibold text-slate-700">${i.minStock}</td>
                </tr>
            `).join('') || `<tr><td colspan="5" class="p-6 text-center text-emerald-600 font-bold">Không có mặt hàng nào dưới định mức tồn!</td></tr>`;
            if (moreWrap) moreWrap.classList.toggle('hidden', lowItems.length <= detailedReportLimit);
            return;
        }

        // 8. BÁO CÁO LÃI LỖ KẾ TOÁN (8 CHỈ TIÊU)
        if (currentDetailedReportType === 'FIN_PNL') {
            const [ordSnap, cbSnap] = await Promise.all([
                db.collection("orders").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get(),
                db.collection("cashbook").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get()
            ]);

            let netSales = 0, returnVal = 0, cogs = 0;
            ordSnap.docs.map(d => d.data()).forEach(o => {
                if (o.status === 'PROCESSING') return;
                if (o.orderType === 'RETURN') {
                    returnVal += Number(o.totalAmount) || 0;
                } else {
                    netSales += Number(o.totalAmount) || 0;
                    cogs += Number(o.totalCost) || 0;
                }
            });
            const grossSales = netSales + returnVal;
            const grossProfit = netSales - cogs;

            let otherIncome = 0, otherExpense = 0;
            cbSnap.docs.map(d => d.data()).forEach(c => {
                if (c.category === 'OPERATING') {
                    if (c.type === 'INCOME') otherIncome += Number(c.amount) || 0;
                    else if (c.type === 'EXPENSE') otherExpense += Number(c.amount) || 0;
                }
            });
            const netProfit = grossProfit + otherIncome - otherExpense;

            thead.innerHTML = `<tr><th class="p-3">Chỉ tiêu kế toán</th><th class="p-3 text-right">Giá trị (VNĐ)</th></tr>`;
            const rows = [
                { name: '1. Doanh thu bán hàng', val: grossSales, cls: 'font-bold text-slate-800' },
                { name: '2. Trừ: Giá trị hàng bán bị trả lại', val: returnVal, cls: 'text-red-600' },
                { name: '3. Doanh thu thuần (1 - 2)', val: netSales, cls: 'font-black text-[#0088FF] bg-blue-50/40' },
                { name: '4. Trừ: Giá vốn hàng bán', val: cogs, cls: 'text-slate-600' },
                { name: '5. Lợi nhuận gộp (3 - 4)', val: grossProfit, cls: 'font-black text-emerald-700 bg-emerald-50/40' },
                { name: '6. Cộng: Thu nhập khác (Phiếu thu ngoài bán hàng)', val: otherIncome, cls: 'text-emerald-600' },
                { name: '7. Trừ: Chi phí khác (Phiếu chi vận hành)', val: otherExpense, cls: 'text-red-600' },
                { name: '8. LỢI NHUẬN RÒNG (5 + 6 - 7)', val: netProfit, cls: 'font-black text-base text-emerald-700 bg-emerald-100/60' }
            ];
            tbody.innerHTML = rows.map(r => `<tr class="${r.cls}"><td class="p-3">${r.name}</td><td class="p-3 text-right">${formatmoney(r.val)} đ</td></tr>`).join('');
            return;
        }

        // 9. BÁO CÁO SỔ QUỸ (ĐẦU KỲ, THU, CHI, TỒN CUỐI)
        if (currentDetailedReportType === 'FIN_CASHBOOK') {
            const snap = await db.collection("cashbook").get();
            const allVouchers = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);

            let openBal = 0, periodIn = 0, periodOut = 0;
            const periodList = [];

            allVouchers.forEach(v => {
                const amt = Number(v.amount) || 0;
                const isInc = v.type === 'INCOME';
                if (v.dateStr < fromStr) {
                    openBal += isInc ? amt : -amt;
                } else if (v.dateStr >= fromStr && v.dateStr <= toStr) {
                    if (isInc) periodIn += amt;
                    else periodOut += amt;
                    if (!kw || (v.voucherCode || '').toLowerCase().includes(kw) || (v.note || '').toLowerCase().includes(kw)) {
                        periodList.push(v);
                    }
                }
            });
            const closeBal = openBal + periodIn - periodOut;

            banner.innerHTML = `
                <div class="bg-white p-3 rounded-xl border border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div><div class="text-slate-400">Quỹ đầu kỳ</div><div class="font-bold text-slate-800">${formatmoney(openBal)} đ</div></div>
                    <div><div class="text-slate-400">Tổng thu trong kỳ</div><div class="font-bold text-emerald-600">+${formatmoney(periodIn)} đ</div></div>
                    <div><div class="text-slate-400">Tổng chi trong kỳ</div><div class="font-bold text-red-600">-${formatmoney(periodOut)} đ</div></div>
                    <div><div class="text-slate-400">Tồn quỹ cuối kỳ</div><div class="font-black text-[#0088FF]">${formatmoney(closeBal)} đ</div></div>
                </div>`;

            thead.innerHTML = `<tr><th class="p-2.5">Ngày giờ</th><th class="p-2.5">Mã phiếu</th><th class="p-2.5">Loại</th><th class="p-2.5">Nội dung</th><th class="p-2.5 text-right">Số tiền</th></tr>`;
            tbody.innerHTML = periodList.slice(0, detailedReportLimit).map(v => {
                const isInc = v.type === 'INCOME';
                return `<tr>
                    <td class="p-2.5 text-slate-500">${v.dateStr}</td>
                    <td class="p-2.5 font-bold">${v.voucherCode || ''}</td>
                    <td class="p-2.5">${isInc ? '<span class="text-emerald-600 font-bold">Phiếu thu</span>' : '<span class="text-red-600 font-bold">Phiếu chi</span>'}</td>
                    <td class="p-2.5 text-slate-700">${v.note || ''}</td>
                    <td class="p-2.5 text-right font-black ${isInc ? 'text-emerald-600' : 'text-red-600'}">${isInc ? '+' : '-'}${formatmoney(v.amount)} đ</td>
                </tr>`;
            }).join('') || `<tr><td colspan="5" class="p-6 text-center text-slate-400">Không có giao dịch trong kỳ</td></tr>`;
            if (moreWrap) moreWrap.classList.toggle('hidden', periodList.length <= detailedReportLimit);
            return;
        }

        // 10 & 11. BÁO CÁO CÔNG NỢ KHÁCH HÀNG & CÔNG NỢ NHÀ CUNG CẤP
        if (currentDetailedReportType === 'FIN_DEBT_CUST' || currentDetailedReportType === 'FIN_DEBT_SUP') {
            const isSup = currentDetailedReportType === 'FIN_DEBT_SUP';
            const debtSnap = await db.collection("debts").where("createdAt", ">=", fromTime).get();
            const recentDebts = debtSnap.docs.map(d => d.data());

            const partners = customers.filter(c => (isSup ? c.type === 'SUPPLIER' : c.type !== 'SUPPLIER') && (!kw || c.name.toLowerCase().includes(kw) || (c.phone || '').includes(kw)));
            thead.innerHTML = `<tr><th class="p-2.5">Tên đối tác (Bấm xem lịch sử)</th><th class="p-2.5 text-right">Nợ đầu kỳ</th><th class="p-2.5 text-right">Phát sinh trong kỳ</th><th class="p-2.5 text-right">Đã trả trong kỳ</th><th class="p-2.5 text-right">Dư nợ cuối kỳ</th></tr>`;

            tbody.innerHTML = partners.slice(0, detailedReportLimit).map(p => {
                let changeAfterTo = 0, periodAdd = 0, periodPaid = 0;
                recentDebts.forEach(d => {
                    if (d.customerId !== p.id) return;
                    const chg = Number(d.changeAmount) || 0;
                    if (d.createdAt > toTime) changeAfterTo += chg;
                    else if (d.createdAt >= fromTime && d.createdAt <= toTime) {
                        if (chg > 0) periodAdd += chg;
                        else if (chg < 0) periodPaid += Math.abs(chg);
                    }
                });
                const closeDebt = Math.max(0, (Number(p.currentDebt) || 0) - changeAfterTo);
                const openDebt = Math.max(0, closeDebt - periodAdd + periodPaid);

                return `<tr onclick="openDebtLedgerModal('${p.id}')" class="cursor-pointer hover:bg-blue-50/50">
                    <td class="p-2.5 font-bold text-[#0088FF] underline">${p.name}</td>
                    <td class="p-2.5 text-right font-semibold">${formatmoney(openDebt)} đ</td>
                    <td class="p-2.5 text-right text-red-600 font-bold">+${formatmoney(periodAdd)} đ</td>
                    <td class="p-2.5 text-right text-emerald-600 font-bold">-${formatmoney(periodPaid)} đ</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${formatmoney(closeDebt)} đ</td>
                </tr>`;
            }).join('') || `<tr><td colspan="5" class="p-6 text-center text-slate-400">Không có dữ liệu đối tác</td></tr>`;
            if (moreWrap) moreWrap.classList.toggle('hidden', partners.length <= detailedReportLimit);
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Lỗi truy vấn báo cáo: ${err.message}</td></tr>`;
    }
}

async function editReportItem(productName, oldBaseQty, oldRev, oldCost) {
    const rawQty = prompt(`Sửa Tổng SL đã bán của "${productName}":`, oldBaseQty);
    if (rawQty === null) return;
    const newBaseQty = parseInt(rawQty.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;
    if (newBaseQty <= 0) return alert("Số lượng phải lớn hơn 0!");

    const rawRev = prompt(`Sửa Tổng Doanh Thu của "${productName}" (VNĐ):`, oldRev);
    if (rawRev === null) return;
    const newRev = parseInt(rawRev.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;

    const rawCost = prompt(`Sửa Tổng Tiền Vốn của "${productName}" (VNĐ):`, oldCost);
    if (rawCost === null) return;
    const newCost = parseInt(rawCost.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;

    const fromStr = document.getElementById('rep-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('rep-date-to')?.value || '2060-12-31';

    try {
        const snap = await db.collection("orders").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get();
        let applied = false;
        for (const doc of snap.docs) {
            const ord = doc.data();
            if (ord.orderType !== 'SALE' || (Number(ord.totalAmount) || 0) <= 0) continue;
            let modified = false;
            const updatedItems = [];
            (ord.items || []).forEach(item => {
                if (item.productName === productName && (Number(item.qty) || 0) > 0) {
                    modified = true;
                    if (!applied) {
                        applied = true;
                        const rate = Number(item.conversionRate) || 1;
                        const newQty = Math.max(1, Math.round(newBaseQty / rate));
                        updatedItems.push({
                            ...item, qty: newQty, baseQty: newBaseQty,
                            unitPrice: Math.round(newRev / newQty), totalPrice: newRev,
                            costPricePerBase: Math.round(newCost / newBaseQty), totalCost: newCost
                        });
                    }
                } else updatedItems.push(item);
            });
            if (modified) {
                await doc.ref.update({
                    items: updatedItems,
                    totalAmount: updatedItems.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0),
                    totalCost: updatedItems.reduce((s, i) => s + (Number(i.totalCost) || 0), 0)
                });
            }
        }
        loadReportsModule();
        if (typeof loadOverviewDashboard === 'function') loadOverviewDashboard();
    } catch (e) {
        alert("Lỗi khi sửa báo cáo: " + e.message);
    }
}

async function deleteReportItem(productName) {
    if (!confirm(`XÓA mặt hàng "${productName}" khỏi Báo cáo trong kỳ này?`)) return;
    const fromStr = document.getElementById('rep-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('rep-date-to')?.value || '2060-12-31';
    try {
        const snap = await db.collection("orders").where("dateStr", ">=", fromStr).where("dateStr", "<=", toStr).get();
        for (const doc of snap.docs) {
            const ord = doc.data();
            if (ord.orderType !== 'SALE') continue;
            const remainingItems = (ord.items || []).filter(i => i.productName !== productName);
            if (remainingItems.length !== (ord.items || []).length) {
                await doc.ref.update({
                    items: remainingItems,
                    totalAmount: remainingItems.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0),
                    totalCost: remainingItems.reduce((s, i) => s + (Number(i.totalCost) || 0), 0)
                });
            }
        }
        loadReportsModule();
    } catch (e) {
        alert("Lỗi khi xóa dòng báo cáo: " + e.message);
    }
}

function initMobileAutoHideToolbar() {}
