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

// Khởi tạo lắng nghe danh sách Khách hàng (CRM)
db.collection("customers").onSnapshot((snap) => {
    customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    customers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderPosCustomerSelect();
    renderCrmModule();
});

window.addEventListener('load', () => {
    updateHoldBadge();
    initKeyboardShortcuts();
    initOrderDateFilter();
});

function initOrderDateFilter() {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    
    const fromEl = document.getElementById('ord-date-from');
    const toEl = document.getElementById('ord-date-to');
    if (fromEl) fromEl.value = fmt(firstDay);
    if (toEl) toEl.value = fmt(today);
}

// Phím tắt bàn phím chuẩn Sapo POS trên PC
function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F1') { e.preventDefault(); switchTab('tab-sell'); }
        else if (e.key === 'F2') {
            e.preventDefault();
            switchTab('tab-sell');
            document.getElementById('sell-search-name')?.focus();
        }
        else if (e.key === 'F3') { e.preventDefault(); openZaloModal(); }
        else if (e.key === 'F4') {
            e.preventDefault();
            switchTab('tab-sell');
            document.getElementById('pos-customer-select')?.focus();
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

// ==========================================
// MODULE 1: LÊN ĐƠN TỰ ĐỘNG TỪ VĂN BẢN ZALO (NLP / REGEX ENGINE)
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

    tbody.innerHTML = lastParsedZaloItems.map((row, idx) => {
        if (!row.matched) {
            return `
                <tr class="bg-red-50/60">
                    <td class="p-2 font-medium text-slate-700">"${row.rawSegment}"</td>
                    <td class="p-2 text-red-600 font-bold" colspan="3"><i class="fa-solid fa-circle-xmark mr-1"></i>Không tìm thấy tên hàng khớp trong kho</td>
                </tr>
            `;
        }
        const u = row.product.units[row.unitIndex];
        const unitOptions = row.product.units.map((unitObj, uIdx) => 
            `<option value="${uIdx}" ${uIdx === row.unitIndex ? 'selected' : ''}>${unitObj.unitName} (${formatmoney(unitObj.sellingPrice)}đ)</option>`
        ).join('');

        return `
            <tr class="bg-emerald-50/40">
                <td class="p-2 text-slate-500">"${row.rawSegment}"</td>
                <td class="p-2 font-bold text-slate-800"><i class="fa-solid fa-circle-check text-emerald-600 mr-1"></i>${row.product.name}</td>
                <td class="p-2 text-center">
                    <div class="flex items-center justify-center gap-1">
                        <input type="number" value="${row.qty}" min="1" onchange="lastParsedZaloItems[${idx}].qty = parseInt(this.value)||1" class="w-12 border rounded p-1 text-center font-bold">
                        <select onchange="lastParsedZaloItems[${idx}].unitIndex = parseInt(this.value)" class="border rounded p-1 text-xs font-bold bg-white text-inni-blue">
                            ${unitOptions}
                        </select>
                    </div>
                </td>
                <td class="p-2 text-right font-bold text-red-600">${formatmoney(u.sellingPrice * row.qty)} đ</td>
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
// MODULE 2: GIAO DIỆN POS BÁN SỈ, QUÉT MÃ VẠCH & GIỎ HÀNG
// ==========================================
function handlePosSearchEnter(e) {
    if (e.key !== 'Enter') return;
    const query = e.target.value.trim();
    if (!query) return;

    if (tryAddByBarcode(query)) {
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

function renderSellGrid() {
    const grid = document.getElementById('sell-grid');
    const noResult = document.getElementById('sell-no-result');
    if (!grid) return;
    grid.innerHTML = '';

    const rawSearch = (document.getElementById('sell-search-name')?.value || '').trim();
    const normSearch = removeVN(rawSearch);
    const filterCat = document.getElementById('sell-search-cat')?.value || 'all';
    let count = 0;

    inventory.forEach(item => {
        if (filterCat !== 'all' && item.category !== filterCat) return;
        if (normSearch) {
            const matchName = removeVN(item.name).includes(normSearch);
            const matchKw = item.keywords.some(k => removeVN(k).includes(normSearch));
            const matchBc = (item.barcode && item.barcode.includes(rawSearch)) || item.units.some(u => u.barcode && u.barcode.includes(rawSearch));
            if (!matchName && !matchKw && !matchBc) return;
        }
        count++;

        const isOut = item.stock <= 0;
        const isLow = item.stock > 0 && item.stock <= item.minStock;

        const imgTag = item.image 
            ? `<div class="w-full h-20 bg-white rounded-lg mb-1.5 border border-slate-100 flex items-center justify-center overflow-hidden relative">
                    <img src="${item.image}" class="max-w-full max-h-full object-contain">
                    <span class="absolute top-1 right-1 text-[10px] font-bold px-1.5 py-0.2 rounded ${isOut ? 'bg-red-600 text-white' : (isLow ? 'bg-amber-500 text-white' : 'bg-emerald-100 text-emerald-800')}">
                        ${isOut ? 'Hết' : `Tồn: ${item.stock}`}
                    </span>
               </div>`
            : `<div class="w-full h-20 bg-slate-50 rounded-lg mb-1.5 flex items-center justify-center text-slate-300 border border-slate-100 relative">
                    <i class="fa-solid fa-box text-2xl"></i>
                    <span class="absolute top-1 right-1 text-[10px] font-bold px-1.5 py-0.2 rounded ${isOut ? 'bg-red-600 text-white' : (isLow ? 'bg-amber-500 text-white' : 'bg-emerald-100 text-emerald-800')}">
                        ${isOut ? 'Hết' : `Tồn: ${item.stock}`}
                    </span>
               </div>`;

        const unitButtonsHtml = item.units.map((u, uIdx) => {
            const isWholesale = u.conversionRate > 1;
            const btnStyle = isWholesale 
                ? 'bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm' 
                : 'bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold border border-slate-200';
            return `
                <button onclick="addToCartWithUnit('${item.id}', ${uIdx}, 1, false)" class="w-full py-1.5 px-2 rounded-lg text-[11px] flex justify-between items-center transition scale-active ${btnStyle}">
                    <span class="truncate">+1 ${u.unitName}${isWholesale ? ` (${u.conversionRate})` : ''}</span>
                    <span class="${isWholesale ? 'text-amber-300 font-black' : 'text-red-600 font-bold'} ml-1">${formatmoney(u.sellingPrice)}đ</span>
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
    });

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

function getCustomerRememberedPrice(customerId, productId, unitName, defaultPrice) {
    if (!customerId || customerId === 'GUEST') return defaultPrice;
    const priceMemory = JSON.parse(localStorage.getItem('hh_customer_prices')) || {};
    const memKey = `${customerId}_${productId}_${unitName}`;
    return priceMemory[memKey] !== undefined ? priceMemory[memKey] : defaultPrice;
}

function saveCustomerPriceMemory(customerId, productId, unitName, customPrice) {
    if (!customerId || customerId === 'GUEST' || customPrice <= 0) return;
    const priceMemory = JSON.parse(localStorage.getItem('hh_customer_prices')) || {};
    priceMemory[`${customerId}_${productId}_${unitName}`] = customPrice;
    localStorage.setItem('hh_customer_prices', JSON.stringify(priceMemory));
}

function addToCartWithUnit(productId, unitIndex = 0, addQty = 1, isGift = false) {
    const item = inventory.find(i => i.id === productId);
    if (!item) return;

    const u = item.units[unitIndex] || item.units[0];
    const cartKey = `${productId}_${unitIndex}_${isGift ? 'GIFT' : 'SALE'}`;

    const neededBaseQty = addQty * u.conversionRate;
    const currentBaseInCart = getTotalBaseQtyInCart(productId);

    if (currentBaseInCart + neededBaseQty > item.stock) {
        return alert(`Không đủ tồn kho cho "${item.name}"!\n- Tồn kho hiện tại: ${item.stock} ${item.baseUnit}\n- Trong giỏ đã có: ${currentBaseInCart} ${item.baseUnit}`);
    }

    const card = document.getElementById('pos-card-' + productId);
    if (card) {
        card.classList.add('item-added');
        setTimeout(() => card.classList.remove('item-added'), 250);
    }

    if (!cart[cartKey]) {
        const initialPrice = isGift ? 0 : getCustomerRememberedPrice(selectedCustomerId, productId, u.unitName, u.sellingPrice);
        cart[cartKey] = {
            cartKey,
            productId: item.id,
            name: item.name,
            baseUnit: item.baseUnit,
            unitIndex: unitIndex,
            unitName: u.unitName,
            conversionRate: u.conversionRate,
            price: initialPrice,
            originalPrice: u.sellingPrice,
            costPricePerBase: item.costPrice,
            qty: 0,
            isGift: isGift
        };
    }

    cart[cartKey].qty += addQty;
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
        alert(`Kho chỉ còn ${prod.stock} ${prod.baseUnit}, không đủ để đổi sang ${cItem.qty} ${newUnit.unitName} (${cItem.qty * newUnit.conversionRate} ${prod.baseUnit})!`);
        renderCart();
        return;
    }

    const newKey = `${cItem.productId}_${newUnitIndex}_${cItem.isGift ? 'GIFT' : 'SALE'}`;
    const newPrice = cItem.isGift ? 0 : getCustomerRememberedPrice(selectedCustomerId, cItem.productId, newUnit.unitName, newUnit.sellingPrice);

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
            originalPrice: newUnit.sellingPrice
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

    if (selectedCustomerId !== 'GUEST' && newPrice > 0) {
        saveCustomerPriceMemory(selectedCustomerId, cItem.productId, cItem.unitName, newPrice);
    }
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
    if (!list) return;
    list.innerHTML = '';

    const keys = Object.keys(cart);
    countEl.innerText = keys.length;

    if (keys.length === 0) {
        list.innerHTML = `<li class="text-center text-slate-400 text-xs italic mt-12">Giỏ hàng trống. Hãy bấm chọn món, quét mã vạch hoặc dán đơn Zalo!</li>`;
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
            ? `<span class="bg-purple-600 text-white text-[10px] px-1.5 py-0.2 rounded font-bold ml-1">🎁 HÀNG TẶNG 0Đ</span>` 
            : '';

        list.innerHTML += `
            <li class="p-2.5 rounded-xl border ${item.isGift ? 'bg-purple-50/60 border-purple-300' : 'bg-slate-50 border-slate-200'} flex flex-col gap-2 animate-fade-in shadow-sm">
                <div class="flex justify-between items-start gap-2">
                    <div class="font-bold text-slate-800 text-xs leading-snug flex-1">
                        ${item.name} ${giftBadge}
                        <span class="block text-[10px] text-slate-400 font-normal">Trừ kho: ${item.qty * item.conversionRate} ${item.baseUnit}</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button onclick="toggleCartItemGift('${key}')" title="Chuyển thành Hàng tặng khuyến mãi 0đ" class="text-[10px] font-bold px-2 py-0.5 rounded border transition ${item.isGift ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'}">
                            🎁 Tặng 0đ
                        </button>
                        <button onclick="updateCartQty('${key}', -99999)" class="text-slate-400 hover:text-red-500 px-1"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div class="grid grid-cols-12 gap-1.5 items-center">
                    <div class="col-span-4">
                        <select onchange="changeCartItemUnit('${key}', parseInt(this.value))" class="w-full border border-slate-300 rounded-lg p-1 text-xs font-bold bg-white text-inni-blue focus:outline-none">
                            ${unitSelectHtml}
                        </select>
                    </div>

                    <div class="col-span-4 relative">
                        <input type="text" value="${formatmoney(item.price)}" oninput="updateCartCustomPrice('${key}', this)" title="Click để sửa giá bán trực tiếp" class="w-full border border-amber-400 bg-amber-50/50 focus:bg-white rounded-lg p-1 pr-4 text-xs font-black text-red-600 text-right focus:outline-none">
                        <i class="fa-solid fa-pen text-[8px] text-amber-500 absolute right-1.5 top-2 pointer-events-none"></i>
                    </div>

                    <div class="col-span-4 flex items-center justify-end gap-1">
                        <button onclick="updateCartQty('${key}', -1)" class="w-6 h-6 bg-white border border-slate-300 rounded flex items-center justify-center text-slate-600 hover:bg-slate-100 scale-active"><i class="fa-solid fa-minus text-[9px]"></i></button>
                        <input type="number" value="${item.qty}" onchange="updateCartQty('${key}', 0, this.value)" class="w-10 border border-slate-300 rounded p-0.5 text-center font-black text-xs text-slate-800 bg-white">
                        <button onclick="updateCartQty('${key}', 1)" class="w-6 h-6 bg-white border border-slate-300 rounded flex items-center justify-center text-slate-600 hover:bg-slate-100 scale-active"><i class="fa-solid fa-plus text-[9px]"></i></button>
                    </div>
                </div>

                <div class="flex justify-between items-center text-[11px] pt-1 border-t border-slate-200/70">
                    <span class="text-slate-400">Thành tiền dòng này:</span>
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

// ==========================================
// QUẢN LÝ KHÁCH HÀNG TRÊN MÀN HÌNH POS
// ==========================================
function renderPosCustomerSelect() {
    const sel = document.getElementById('pos-customer-select');
    if (!sel) return;
    const currentVal = sel.value || 'GUEST';
    sel.innerHTML = `<option value="GUEST">👤 Khách Lẻ (Vãng lai)</option>`;
    customers.filter(c => c.type !== 'SUPPLIER').forEach(c => {
        const debtText = c.currentDebt > 0 ? ` (Nợ: ${formatmoney(c.currentDebt)}đ)` : '';
        sel.innerHTML += `<option value="${c.id}">🏪 ${c.name} - ${c.phone || ''}${debtText}</option>`;
    });
    sel.value = customers.some(c => c.id === currentVal) ? currentVal : 'GUEST';
    onSelectPosCustomer();
}

function onSelectPosCustomer() {
    const sel = document.getElementById('pos-customer-select');
    selectedCustomerId = sel ? sel.value : 'GUEST';
    const cust = customers.find(c => c.id === selectedCustomerId);
    const badge = document.getElementById('pos-customer-debt-badge');

    if (cust && cust.currentDebt > 0) {
        badge.innerText = `Nợ cũ: ${formatmoney(cust.currentDebt)}đ`;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
    updateCartTotalsOnly();
}

async function quickAddCustomerPrompt() {
    openCustomerModal(null);
}

// ==========================================
// LƯU TẠM ĐƠN HÀNG (HOLD ORDERS - F8)
// ==========================================
function updateHoldBadge() {
    const badge = document.getElementById('hold-count-badge');
    if (badge) badge.innerText = holdOrders.length;
}

function holdCurrentOrder() {
    if (Object.keys(cart).length === 0) return alert("Giỏ hàng đang trống, không có gì để lưu tạm!");
    const note = prompt("Ghi chú đơn lưu tạm (VD: Anh Ba chờ lấy thêm bia):", "Khách đang lựa thêm");
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
    selectedCustomerId = "GUEST";
    document.getElementById('pos-customer-select').value = "GUEST";
    onSelectPosCustomer();
    renderCart();
    updateHoldBadge();
}

function openHoldOrdersModal() {
    const list = document.getElementById('hold-orders-list');
    list.innerHTML = '';

    if (holdOrders.length === 0) {
        list.innerHTML = `<div class="text-center p-8 text-slate-400 italic text-sm">Chưa có đơn hàng nào đang lưu tạm.</div>`;
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
                            Gọi Lại Đơn
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
        if (!confirm("Giỏ hàng hiện tại đang có đồ. Gọi lại đơn tạm sẽ ghi đè giỏ hàng hiện tại. Tiếp tục?")) return;
    }
    const h = holdOrders[idx];
    if (!h) return;

    cart = h.cartData;
    selectedCustomerId = h.customerId || "GUEST";
    const sel = document.getElementById('pos-customer-select');
    if (sel) sel.value = selectedCustomerId;
    onSelectPosCustomer();

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
// THANH TOÁN ĐƠN HÀNG & GHI SỔ CÔNG NỢ / THẺ KHO
// ==========================================
function openCheckoutModal() {
    if (Object.keys(cart).length === 0) return alert("Giỏ hàng đang trống!");

    let orderTotal = 0;
    for (const k in cart) orderTotal += cart[k].price * cart[k].qty;

    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
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

function closeCheckoutModal() {
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
    let orderTotal = 0;
    for (const k in cart) orderTotal += cart[k].price * cart[k].qty;
    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
    document.getElementById('chk-paid-input').value = formatmoney(orderTotal + oldDebt);
    calcCheckoutDebt();
}

function calcCheckoutDebt() {
    let orderTotal = 0;
    for (const k in cart) orderTotal += cart[k].price * cart[k].qty;
    const cust = customers.find(c => c.id === selectedCustomerId);
    const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
    const grandTotal = orderTotal + oldDebt;

    const paid = getRawNum('chk-paid-input');
    const labelEl = document.getElementById('chk-balance-label');
    const valEl = document.getElementById('chk-balance-value');

    if (paid >= grandTotal) {
        labelEl.innerText = "Tiền thừa trả lại khách:";
        valEl.innerText = `${formatmoney(paid - grandTotal)} đ`;
        valEl.className = "text-lg font-black text-blue-600";
    } else {
        labelEl.innerText = "Còn nợ lại (Ghi vào sổ công nợ):";
        valEl.innerText = `${formatmoney(grandTotal - paid)} đ`;
        valEl.className = "text-lg font-black text-red-600";
    }
}

async function confirmPosCheckout() {
    let orderTotal = 0;
    let totalCost = 0;
    const orderItems = [];

    for (const k in cart) {
        const c = cart[k];
        const baseQty = c.qty * c.conversionRate;
        const lineTotal = c.price * c.qty;
        const lineCost = baseQty * c.costPricePerBase;

        orderTotal += lineTotal;
        totalCost += lineCost;

        orderItems.push({
            productId: c.productId,
            productName: c.name,
            baseUnit: c.baseUnit,
            unitName: c.unitName,
            conversionRate: c.conversionRate,
            qty: c.qty,
            baseQty: baseQty,
            unitPrice: c.price,
            costPricePerBase: c.costPricePerBase,
            totalPrice: lineTotal,
            totalCost: lineCost,
            isGift: !!c.isGift
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

    const btn = document.getElementById('btn-confirm-checkout');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý đơn...`;

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const orderCode = `BH-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const seller = document.getElementById('seller-name').value.trim() || "Chủ Quán";

    try {
        const orderData = {
            orderCode,
            orderType: "SALE",
            customerId: selectedCustomerId,
            customerSnapshot: cust ? { name: cust.name, phone: cust.phone || '', address: cust.address || '' } : { name: "Khách Lẻ", phone: "", address: "" },
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
            await db.collection("customers").doc(cust.id).update({
                currentDebt: newDebt,
                updatedAt: Date.now()
            });
            await db.collection("debts").add({
                customerId: cust.id,
                customerName: cust.name,
                ledgerType: "RECEIVABLE",
                transactionType: "ORDER_DEBT",
                referenceId: orderCode,
                beforeDebt: oldDebt,
                changeAmount: newDebt - oldDebt,
                afterDebt: newDebt,
                note: `Mua đơn ${orderCode} (Tổng: ${formatmoney(orderTotal)}đ, Trả: ${formatmoney(actualPaidRecorded)}đ)`,
                createdAt: Date.now()
            });
        }

        if (actualPaidRecorded > 0) {
            await db.collection("cashbook").add({
                voucherCode: "PT-" + orderCode.split('-').pop(),
                type: "INCOME",
                channel: currentPaymentMethod === 'BANK' ? 'BANK' : 'CASH',
                category: "SALE",
                amount: actualPaidRecorded,
                referenceId: orderCode,
                note: `Thu tiền bán hàng đơn ${orderCode} (${cust ? cust.name : 'Khách lẻ'})`,
                seller,
                dateStr,
                createdAt: Date.now()
            });
        }

        playBeepSound();
        closeCheckoutModal();
        cart = {};
        renderCart();
        openPrintableInvoice(orderData);
    } catch (e) {
        alert("Lỗi khi lưu đơn hàng: " + e.message);
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-print"></i> Hoàn Tất & Xuất Hóa Đơn`;
}

// ==========================================
// MODULE 4: HÓA ĐƠN A5 / 80MM, TÍCH HỢP VIETQR & LỊCH SỬ HÓA ĐƠN
// ==========================================
function setInvoicePrintMode(mode) {
    document.body.classList.remove('print-mode-A5', 'print-mode-80mm');
    document.body.classList.add('print-mode-' + mode);

    const btnA5 = document.getElementById('btn-mode-A5');
    const btn80 = document.getElementById('btn-mode-80mm');
    if (mode === 'A5') {
        btnA5.className = "px-2.5 py-1 rounded text-xs font-bold bg-blue-600 text-white";
        btn80.className = "px-2.5 py-1 rounded text-xs font-bold bg-slate-700 text-slate-300";
    } else {
        btn80.className = "px-2.5 py-1 rounded text-xs font-bold bg-blue-600 text-white";
        btnA5.className = "px-2.5 py-1 rounded text-xs font-bold bg-slate-700 text-slate-300";
    }
}

function openPrintableInvoice(order) {
    currentViewingOrder = order;
    setInvoicePrintMode(storeSettings.printSize || 'A5');

    document.getElementById('bill-store-name').innerText = (storeSettings.storeName || "TẠP HÓA HUY HOÀNG").toUpperCase();
    document.getElementById('bill-store-phone').innerText = storeSettings.phone || "---";
    document.getElementById('bill-store-address').innerText = storeSettings.address || "";

    document.getElementById('bill-title-type').innerText = order.orderType === 'RETURN' ? 'PHIẾU HOÀN TRẢ HÀNG' : 'HÓA ĐƠN BÁN HÀNG';
    document.getElementById('bill-detail-id').innerText = order.orderCode;
    document.getElementById('bill-detail-date').innerText = new Date(order.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
    document.getElementById('bill-detail-seller').innerText = order.seller || "Chủ Quán";

    const snap = order.customerSnapshot || { name: "Khách Lẻ", phone: "", address: "" };
    document.getElementById('bill-cust-name').innerText = snap.name || "Khách Lẻ";
    document.getElementById('bill-cust-phone').innerText = snap.phone || "---";
    document.getElementById('bill-cust-address').innerText = snap.address || "---";

    const tbody = document.getElementById('bill-detail-items');
    tbody.innerHTML = '';
    (order.items || []).forEach((item, idx) => {
        const giftLabel = item.isGift ? ` (Tặng 0đ)` : '';
        tbody.innerHTML += `
            <tr>
                <td class="border border-slate-400 p-1.5 text-center a5-only-col">${idx + 1}</td>
                <td class="border border-slate-400 p-1.5 font-semibold">${item.productName}${giftLabel}</td>
                <td class="border border-slate-400 p-1.5 text-center">${item.unitName}</td>
                <td class="border border-slate-400 p-1.5 text-center font-bold">${item.qty}</td>
                <td class="border border-slate-400 p-1.5 text-right">${formatmoney(item.unitPrice)}</td>
                <td class="border border-slate-400 p-1.5 text-right font-bold">${formatmoney(item.totalPrice)}</td>
            </tr>
        `;
    });

    document.getElementById('bill-detail-total').innerText = `${formatmoney(order.totalAmount)} đ`;
    document.getElementById('bill-old-debt').innerText = `${formatmoney(order.oldDebt || 0)} đ`;
    document.getElementById('bill-paid-amount').innerText = `${formatmoney(order.paidAmount || 0)} đ`;
    document.getElementById('bill-new-debt').innerText = `${formatmoney(order.newDebt || 0)} đ`;

    // Tạo mã VietQR tự động truyền đúng số tiền cần thanh toán
    const qrBox = document.getElementById('bill-vietqr-box');
    const qrImg = document.getElementById('bill-vietqr-img');
    const bankInfo = document.getElementById('bill-bank-info');

    if (storeSettings.bankAcc && storeSettings.bankId) {
        const amountToTransfer = order.newDebt > 0 ? order.newDebt : order.totalAmount;
        const addInfo = encodeURIComponent(`TT ${order.orderCode}`);
        const accName = encodeURIComponent(storeSettings.bankOwner || "");
        qrImg.src = `https://img.vietqr.io/image/${storeSettings.bankId}-${storeSettings.bankAcc}-compact2.png?amount=${amountToTransfer}&addInfo=${addInfo}&accountName=${accName}`;
        bankInfo.innerText = `${storeSettings.bankId} - ${storeSettings.bankAcc} (${storeSettings.bankOwner || ''})`;
        qrBox.classList.remove('hidden');
    } else {
        qrBox.classList.add('hidden');
    }

    const btnRet = document.getElementById('btn-open-return-from-bill');
    if (order.orderType === 'RETURN') btnRet.classList.add('hidden');
    else btnRet.classList.remove('hidden');

    document.getElementById('bill-detail-modal').classList.remove('hidden');
}

function closeBillModal() {
    document.getElementById('bill-detail-modal').classList.add('hidden');
}

async function loadOrdersModule() {
    const fromStr = document.getElementById('ord-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('ord-date-to')?.value || '2060-12-31';
    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải danh sách hóa đơn...</td></tr>`;

    try {
        const snap = await db.collection("orders")
            .where("dateStr", ">=", fromStr)
            .where("dateStr", "<=", toStr)
            .get();

        ordersList = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);
        renderOrdersList();
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-red-500">Lỗi tải hóa đơn: ${e.message}</td></tr>`;
    }
}

function renderOrdersList() {
    const tbody = document.getElementById('orders-tbody');
    const emptyEl = document.getElementById('orders-empty');
    if (!tbody) return;
    tbody.innerHTML = '';

    const search = (document.getElementById('ord-search-text')?.value || '').toLowerCase().trim();
    const typeFilter = document.getElementById('ord-filter-type')?.value || 'all';
    let count = 0;

    ordersList.forEach((ord, idx) => {
        if (typeFilter !== 'all' && ord.orderType !== typeFilter) return;
        const custName = ord.customerSnapshot?.name || 'Khách Lẻ';
        const custPhone = ord.customerSnapshot?.phone || '';
        if (search && !ord.orderCode.toLowerCase().includes(search) && !custName.toLowerCase().includes(search) && !custPhone.includes(search)) return;

        count++;
        const timeStr = new Date(ord.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const itemsText = (ord.items || []).map(i => `${i.productName} (${i.qty} ${i.unitName})`).join(', ');
        const isReturn = ord.orderType === 'RETURN';

        const badge = isReturn 
            ? `<span class="bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 rounded">HOÀN HÀNG</span>`
            : `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded">XUẤT BÁN</span>`;

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50/40 transition">
                <td class="p-3">
                    <div class="font-bold text-inni-blue flex items-center gap-1.5">${ord.orderCode} ${badge}</div>
                    <div class="text-xs text-slate-400 mt-0.5">${timeStr} • TN: ${ord.seller || 'Chủ Quán'}</div>
                </td>
                <td class="p-3">
                    <div class="font-bold text-slate-800">${custName}</div>
                    <div class="text-xs text-slate-500">${custPhone}</div>
                </td>
                <td class="p-3 text-xs text-slate-600 max-w-xs truncate" title="${itemsText}">${itemsText}</td>
                <td class="p-3 text-right font-black ${isReturn ? 'text-purple-700' : 'text-slate-800'}">${formatmoney(ord.totalAmount)} đ</td>
                <td class="p-3 text-right font-semibold text-emerald-600">${formatmoney(ord.paidAmount || 0)} đ</td>
                <td class="p-3 text-right font-bold text-red-600">${formatmoney(ord.newDebt || 0)} đ</td>
                <td class="p-3 text-center whitespace-nowrap">
                    <button onclick="openPrintableInvoice(ordersList[${idx}])" class="px-2.5 py-1.5 bg-blue-50 hover:bg-inni-blue text-inni-blue hover:text-white rounded-lg text-xs font-bold transition scale-active mr-1">
                        <i class="fa-solid fa-print"></i> Xem / In
                    </button>
                    ${!isReturn ? `
                    <button onclick="openReturnOrderModal(ordersList[${idx}])" class="px-2.5 py-1.5 bg-purple-50 hover:bg-purple-600 text-purple-700 hover:text-white rounded-lg text-xs font-bold transition scale-active">
                        <i class="fa-solid fa-rotate-left"></i> Hoàn Hàng
                    </button>` : ''}
                </td>
            </tr>
        `;
    });

    if (count === 0) emptyEl.classList.remove('hidden');
    else emptyEl.classList.add('hidden');
}

// Hủy toàn bộ đơn hàng và hoàn trả lại tồn kho + công nợ
async function deleteEntireOrder() {
    if (!currentViewingOrder) return;
    const ord = currentViewingOrder;
    if (!confirm(`Bạn có chắc muốn HỦY HÓA ĐƠN "${ord.orderCode}"?\n- Toàn bộ hàng hóa sẽ được hoàn trả lại kho.\n- Công nợ phát sinh của đơn này sẽ được đảo ngược.`)) return;

    try {
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

        if (ord.customerId && ord.customerId !== 'GUEST') {
            const cust = customers.find(c => c.id === ord.customerId);
            const debtDiff = (ord.newDebt || 0) - (ord.oldDebt || 0);
            if (cust && debtDiff !== 0) {
                const updatedDebt = Math.max(0, (cust.currentDebt || 0) - debtDiff);
                await db.collection("customers").doc(cust.id).update({ currentDebt: updatedDebt, updatedAt: Date.now() });
            }
        }

        await db.collection("orders").doc(ord.orderCode).delete();
        closeBillModal();
        loadOrdersModule();
        alert(`Đã hủy hóa đơn ${ord.orderCode} và hoàn trả kho thành công!`);
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
// MODULE 3: QUẢN LÝ KHÁCH HÀNG (CRM), SỔ NỢ & HOÀN HÀNG CẤN TRỪ NỢ
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

        if (typeFilter === 'CUSTOMER' && c.type === 'SUPPLIER') return;
        if (typeFilter === 'SUPPLIER' && c.type !== 'SUPPLIER') return;
        if (typeFilter === 'DEBT_ONLY' && debt <= 0) return;

        if (search && !c.name.toLowerCase().includes(search) && !(c.phone || '').includes(search) && !(c.address || '').toLowerCase().includes(search)) return;
        rendered++;

        const isSup = c.type === 'SUPPLIER';
        const typeBadge = isSup 
            ? `<span class="bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded">🚛 Nhà Cung Cấp</span>`
            : `<span class="bg-blue-100 text-inni-blue text-[11px] font-bold px-2 py-0.5 rounded">🏪 Khách Mua Sỉ/Lẻ</span>`;

        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 font-bold text-slate-800">${c.name}</td>
                <td class="p-3">${typeBadge}</td>
                <td class="p-3 font-semibold text-slate-600">${c.phone || '---'}</td>
                <td class="p-3 text-xs text-slate-500">${c.address || '---'}</td>
                <td class="p-3 text-right font-black ${debt > 0 ? 'text-red-600 text-base' : 'text-emerald-600'}">${formatmoney(debt)} đ</td>
                <td class="p-3 text-center whitespace-nowrap">
                    <button onclick="openDebtLedgerModal('${c.id}')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-amber-300 rounded-lg text-xs font-bold shadow-sm scale-active mr-1">
                        <i class="fa-solid fa-book-bookmark mr-1"></i> Sổ Nợ / Thu Nợ
                    </button>
                    <button onclick="openCustomerModal('${c.id}')" title="Sửa thông tin" class="w-8 h-8 bg-amber-50 hover:bg-amber-500 text-amber-600 hover:text-white rounded-lg inline-flex items-center justify-center border border-amber-200 scale-active mr-1">
                        <i class="fa-solid fa-pen text-xs"></i>
                    </button>
                    <button onclick="deleteCustomer('${c.id}')" title="Xóa khách hàng" class="w-8 h-8 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-lg inline-flex items-center justify-center border border-red-200 scale-active">
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
        document.getElementById('cust-modal-title').innerHTML = `<i class="fa-solid fa-user-plus mr-2"></i>Thêm Khách Hàng / NCC Mới`;
        document.getElementById('cust-id').value = '';
        document.getElementById('cust-type').value = 'CUSTOMER';
        document.getElementById('cust-name').value = '';
        document.getElementById('cust-phone').value = '';
        document.getElementById('cust-address').value = '';
        document.getElementById('cust-debt').value = '0';
    } else {
        const c = customers.find(x => x.id === id);
        if (!c) return;
        document.getElementById('cust-modal-title').innerHTML = `<i class="fa-solid fa-user-pen mr-2"></i>Sửa Thông Tin: ${c.name}`;
        document.getElementById('cust-id').value = c.id;
        document.getElementById('cust-type').value = c.type || 'CUSTOMER';
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
            selectedCustomerId = docRef.id;
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

// --- SỔ GHI NỢ CHI TIẾT (DEBT LEDGER) & THU NỢ ---
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
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải sổ nợ...</td></tr>`;

    try {
        const snap = await db.collection("debts").where("customerId", "==", customerId).limit(60).get();
        const logs = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);
        tbody.innerHTML = '';

        if (logs.length === 0) {
            emptyEl.classList.remove('hidden');
            return;
        }
        emptyEl.classList.add('hidden');

        logs.forEach(log => {
            const dStr = new Date(log.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            let badge = '';
            if (log.transactionType === 'ORDER_DEBT') badge = `<span class="bg-red-100 text-red-700 text-[10px] font-bold px-2 py-0.5 rounded">MUA GHI NỢ</span>`;
            else if (log.transactionType === 'PAYMENT') badge = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded">TRẢ NỢ</span>`;
            else badge = `<span class="bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 rounded">CẤN TRỪ HOÀN HÀNG</span>`;

            const sign = log.changeAmount > 0 ? '+' : '';
            const color = log.changeAmount > 0 ? 'text-red-600 font-black' : 'text-emerald-600 font-black';

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 text-slate-500 whitespace-nowrap">${dStr}</td>
                    <td class="p-2.5">${badge} <b class="ml-1 text-slate-700">${log.referenceId || ''}</b></td>
                    <td class="p-2.5 text-slate-600">${log.note || ''}</td>
                    <td class="p-2.5 text-right text-slate-500 font-semibold">${formatmoney(log.beforeDebt)} đ</td>
                    <td class="p-2.5 text-right ${color}">${sign}${formatmoney(log.changeAmount)} đ</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${formatmoney(log.afterDebt)} đ</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Lỗi: ${e.message}</td></tr>`;
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
        alert(`Đã ghi nhận ${formatmoney(payAmount)}đ vào Sổ nợ & Sổ quỹ!`);
    } catch (e) {
        alert("Lỗi thu nợ: " + e.message);
    }
}

// --- LUỒNG HOÀN HÀNG LỖI / MÓP MÉO (TỰ ĐỘNG CỘNG KHO & CẤN TRỪ CÔNG NỢ) ---
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

    const tbody = document.getElementById('ret-items-tbody');
    tbody.innerHTML = '';
    (order.items || []).forEach((item, idx) => {
        tbody.innerHTML += `
            <tr>
                <td class="p-2 font-bold text-slate-800">${item.productName}<span class="block text-[10px] text-slate-400">Đơn giá: ${formatmoney(item.unitPrice)}đ/${item.unitName}</span></td>
                <td class="p-2 text-center font-semibold">${item.qty} ${item.unitName}</td>
                <td class="p-2 text-center">
                    <input type="number" min="0" max="${item.qty}" value="0" data-idx="${idx}" oninput="calcReturnModalTotal()" class="ret-qty-input w-16 border-2 border-purple-400 rounded p-1 text-center font-black text-purple-700">
                </td>
                <td class="p-2 text-right font-bold text-slate-800" id="ret-line-total-${idx}">0 đ</td>
            </tr>
        `;
    });

    document.getElementById('ret-total-refund').innerText = "0 đ";
    document.getElementById('return-order-modal').classList.remove('hidden');
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
    let totalRefund = 0;
    let totalCostRefund = 0;

    document.querySelectorAll('.ret-qty-input').forEach(inp => {
        const idx = parseInt(inp.getAttribute('data-idx'), 10);
        const rQty = parseInt(inp.value, 10) || 0;
        if (rQty > 0) {
            const origItem = orig.items[idx];
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
    });

    if (returnItems.length === 0) return alert("Vui lòng nhập số lượng cần hoàn trả lớn hơn 0 ở ít nhất 1 món hàng!");

    const refundMode = document.getElementById('ret-refund-mode').value;
    const reason = document.getElementById('ret-reason').value.trim() || "Hoàn hàng lỗi";
    const btn = document.getElementById('btn-submit-return');
    btn.disabled = true;
    btn.innerText = "Đang xử lý hoàn...";

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const retCode = `TH-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        const cust = customers.find(c => c.id === orig.customerId);
        const oldDebt = cust ? (Number(cust.currentDebt) || 0) : 0;
        const newDebt = (cust && refundMode === 'DEBT_OFFSET') ? Math.max(0, oldDebt - totalRefund) : oldDebt;

        // 1. Lưu đơn hoàn hàng
        const retOrderData = {
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
            paidAmount: refundMode === 'CASH_REFUND' ? totalRefund : 0,
            newDebt,
            paymentMethod: refundMode,
            reason,
            dateStr,
            createdAt: Date.now()
        };
        await db.collection("orders").doc(retCode).set(retOrderData);

        // 2. Tự động cộng lại tồn kho & Ghi Thẻ kho
        for (const rItem of returnItems) {
            const dbProd = inventory.find(i => i.id === rItem.productId);
            if (dbProd) {
                const startStock = dbProd.stock;
                const endStock = startStock + rItem.baseQty;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(
                    dbProd.id, dbProd.name, "RETURN", `${retCode} (${reason})`,
                    `Khách trả +${rItem.qty} ${rItem.unitName} (${rItem.baseQty} ${rItem.baseUnit})`,
                    startStock, rItem.baseQty, endStock
                );
            }
        }

        // 3. Tự động cấn trừ vào Công nợ khách hàng hoặc Ghi phiếu chi hoàn tiền mặt
        if (cust && refundMode === 'DEBT_OFFSET' && totalRefund > 0) {
            await db.collection("customers").doc(cust.id).update({ currentDebt: newDebt, updatedAt: Date.now() });
            await db.collection("debts").add({
                customerId: cust.id,
                customerName: cust.name,
                ledgerType: "RECEIVABLE",
                transactionType: "RETURN_OFFSET",
                referenceId: retCode,
                beforeDebt: oldDebt,
                changeAmount: -totalRefund,
                afterDebt: newDebt,
                note: `Cấn trừ hàng hoàn từ đơn ${orig.orderCode} (${reason})`,
                createdAt: Date.now()
            });
        } else if (refundMode === 'CASH_REFUND' && totalRefund > 0) {
            await db.collection("cashbook").add({
                voucherCode: "PC-" + retCode.split('-').pop(),
                type: "EXPENSE",
                channel: "CASH",
                category: "REFUND",
                amount: totalRefund,
                referenceId: retCode,
                note: `Chi tiền mặt hoàn hàng đơn ${orig.orderCode} (${reason})`,
                seller: retOrderData.seller,
                dateStr,
                createdAt: Date.now()
            });
        }

        closeReturnOrderModal();
        loadOrdersModule();
        alert(`✅ Đã hoàn hàng thành công (${retCode})!\n- Đã cộng lại hàng vào Kho & Thẻ kho.\n- ${refundMode === 'DEBT_OFFSET' ? `Đã cấn trừ -${formatmoney(totalRefund)}đ vào công nợ khách!` : `Đã ghi phiếu chi hoàn tiền mặt ${formatmoney(totalRefund)}đ!`}`);
    } catch (e) {
        alert("Lỗi khi hoàn hàng: " + e.message);
    }

    btn.disabled = false;
    btn.innerText = "Xác Nhận Hoàn Hàng & Cộng Kho";
}