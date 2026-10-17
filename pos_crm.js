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

function renderSellGrid() {
    const grid = document.getElementById('sell-grid');
    const noResult = document.getElementById('sell-no-result');
    if (!grid) return;
    grid.innerHTML = '';

    const rawSearch = (document.getElementById('sell-search-name')?.value || '').trim();
    const normSearch = removeVN(rawSearch);
    const filterCat = document.getElementById('sell-search-cat')?.value || 'all';
    const isWholesaleCust = isCurrentCustomerWholesale();
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
            const isBigUnit = u.conversionRate > 1;
            const displayPrice = getStandardUnitPrice(item, uIdx, isWholesaleCust);
            const btnStyle = isBigUnit 
                ? 'bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm' 
                : 'bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold border border-slate-200';
            return `
                <button onclick="addToCartWithUnit('${item.id}', ${uIdx}, 1, false)" class="w-full py-1.5 px-2 rounded-lg text-[11px] flex justify-between items-center transition scale-active ${btnStyle}">
                    <span class="truncate">+1 ${u.unitName}${isBigUnit ? ` (${u.conversionRate})` : ''}</span>
                    <span class="${isBigUnit ? 'text-amber-300 font-black' : 'text-red-600 font-bold'} ml-1">${formatmoney(displayPrice)}đ</span>
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

    const card = document.getElementById('pos-card-' + productId);
    if (card) {
        card.classList.add('item-added');
        setTimeout(() => card.classList.remove('item-added'), 250);
    }

    if (!cart[cartKey]) {
        const isWholesale = isCurrentCustomerWholesale();
        const tierPrice = getStandardUnitPrice(item, unitIndex, isWholesale);
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
    renderCart();
}

// Chuyển toàn bộ giỏ hàng sang Giá Sỉ hoặc Giá Lẻ
function applyTierPriceToAllCart(useWholesalePrice, forceResetManual = false) {
    for (const key in cart) {
        const cItem = cart[key];
        if (cItem.isGift) continue;
        // Giữ nguyên giá nếu thu ngân đã sửa tay (trừ khi bấm nút ép giá cưỡng bức)
        if (cItem.manualPriceEdited && !forceResetManual) continue;
        const prod = inventory.find(i => i.id === cItem.productId);
        if (prod) {
            cItem.price = getStandardUnitPrice(prod, cItem.unitIndex, useWholesalePrice);
            cItem.originalPrice = cItem.price;
            cItem.manualPriceEdited = false;
        }
    }
    const tierBadge = document.getElementById('pos-customer-tier-badge');
    if (tierBadge) {
        tierBadge.innerText = useWholesalePrice ? "Đang áp: Giá Sỉ" : "Đang áp: Giá Lẻ";
        tierBadge.className = useWholesalePrice 
            ? "bg-blue-600 text-white px-1.5 py-0.2 rounded text-[9px] font-bold" 
            : "bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded text-[9px] font-bold";
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
        alert(`Kho chỉ còn ${prod.stock} ${prod.baseUnit}, không đủ để đổi sang ${cItem.qty} ${newUnit.unitName} (${cItem.qty * newUnit.conversionRate} ${prod.baseUnit})!`);
        renderCart();
        return;
    }

    const newKey = `${cItem.productId}_${newUnitIndex}_${cItem.isGift ? 'GIFT' : 'SALE'}`;
    const isWholesale = isCurrentCustomerWholesale();
    const newPrice = cItem.isGift ? 0 : getStandardUnitPrice(prod, newUnitIndex, isWholesale);

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
// TÌM KIẾM KHÁCH HÀNG BẰNG BÀN PHÍM (KEYBOARD-FIRST: MŨI TÊN + ENTER) & TỰ ÁP GIÁ SỈ/LẺ
// ==========================================
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
    sel.innerHTML = `<option value="GUEST">👤 Khách Lẻ (Vãng lai)</option>`;
    customers.filter(c => c.type !== 'SUPPLIER').forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.name} - ${c.phone || ''}</option>`;
    });
    sel.value = customers.some(c => c.id === selectedCustomerId) ? selectedCustomerId : 'GUEST';
    syncCustomerSearchDisplay();
}

function syncCustomerSearchDisplay() {
    const inp = document.getElementById('pos-customer-search');
    const tierBadge = document.getElementById('pos-customer-tier-badge');
    const debtBadge = document.getElementById('pos-customer-debt-badge');

    if (selectedCustomerId === 'GUEST') {
        if (inp) inp.value = "👤 Khách Lẻ (Vãng lai)";
        if (tierBadge) {
            tierBadge.innerText = "Giá Lẻ";
            tierBadge.className = "bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded text-[9px] font-bold";
        }
        if (debtBadge) debtBadge.classList.add('hidden');
    } else {
        const cust = customers.find(c => c.id === selectedCustomerId);
        if (cust) {
            const isWholesale = cust.type === 'WHOLESALE';
            if (inp) inp.value = `${isWholesale ? '🏪' : '👤'} ${cust.name}${cust.phone ? ` (${cust.phone})` : ''}`;
            if (tierBadge) {
                tierBadge.innerText = isWholesale ? "Khách Sỉ (Áp Giá Sỉ)" : "Khách Lẻ (Áp Giá Lẻ)";
                tierBadge.className = isWholesale 
                    ? "bg-blue-600 text-white px-1.5 py-0.2 rounded text-[9px] font-bold" 
                    : "bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded text-[9px] font-bold";
            }
            if (debtBadge) {
                if (cust.currentDebt > 0) {
                    debtBadge.innerText = `Nợ: ${formatmoney(cust.currentDebt)}đ`;
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

    let raw = inp.value.trim();
    if (raw.startsWith('👤') || raw.startsWith('🏪')) raw = '';
    const norm = removeVN(raw);

    const buyerList = customers.filter(c => c.type !== 'SUPPLIER');
    filteredPosCustomers = [
        { id: 'GUEST', name: 'Khách Lẻ (Vãng lai)', phone: '', type: 'RETAIL', currentDebt: 0 },
        ...buyerList.filter(c => {
            if (!norm) return true;
            return removeVN(c.name).includes(norm) || 
                   (c.phone && c.phone.includes(raw)) || 
                   (c.customerCode && removeVN(c.customerCode).includes(norm)) ||
                   removeVN(c.id).includes(norm);
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

    syncCustomerSearchDisplay();
    // Tự động chuyển giá trong giỏ hàng sang Giá Sỉ nếu khách thuộc tệp Khách Sỉ
    const isWholesale = isCurrentCustomerWholesale();
    applyTierPriceToAllCart(isWholesale);
    renderSellGrid();
}

function resetToGuestCustomer() {
    selectPosCustomerFromDropdown('GUEST');
    const inp = document.getElementById('pos-customer-search');
    if (inp) { inp.value = ''; inp.focus(); onInputCustomerSearch(); }
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
        labelEl.innerText = "Còn nợ lại (Ghi vào Sổ Nợ Phải Thu):";
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
// MODULE 4: HÓA ĐƠN IN HEADER VIETQR TĨNH (KHÔNG GẮN SỐ TIỀN) & LỊCH SỬ ĐƠN
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

// Hàm gọi lệnh in AirPrint siêu tốc trên iPhone (Dùng setTimeout giải phóng UI thread chống đơ/lag)
function triggerFastAirPrint() {
    const editBox = document.getElementById('quick-bill-edit-box');
    if (editBox) editBox.classList.add('hidden');
    setTimeout(() => {
        window.print();
    }, 120);
}

// Bật/tắt khung sửa nhanh Tên cửa hàng, SĐT & Tài khoản QR ngay trên đầu Hóa đơn
function toggleQuickBillHeaderEdit() {
    const box = document.getElementById('quick-bill-edit-box');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
        document.getElementById('qb-store-name').value = storeSettings.storeName || "Tạp Hóa Huy Hoàng";
        document.getElementById('qb-store-phone').value = storeSettings.phone || "";
        document.getElementById('qb-store-address').value = storeSettings.address || "";
        document.getElementById('qb-bank-id').value = storeSettings.bankId || "MB";
        document.getElementById('qb-bank-acc').value = storeSettings.bankAcc || "";
        document.getElementById('qb-bank-owner').value = storeSettings.bankOwner || "";
    }
}

// Gõ sửa tới đâu cập nhật ngay lên tờ Hóa đơn & lưu cấu hình tới đó
function applyQuickBillHeaderEdit() {
    storeSettings.storeName = document.getElementById('qb-store-name').value.trim() || "Tạp Hóa Huy Hoàng";
    storeSettings.phone = document.getElementById('qb-store-phone').value.trim();
    storeSettings.address = document.getElementById('qb-store-address').value.trim();
    storeSettings.bankId = document.getElementById('qb-bank-id').value;
    storeSettings.bankAcc = document.getElementById('qb-bank-acc').value.trim();
    storeSettings.bankOwner = document.getElementById('qb-bank-owner').value.trim().toUpperCase();

    localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
    db.collection("shop_data").doc("settings").set(storeSettings).catch(() => {});
    if (typeof applyStoreSettingsToUI === 'function') applyStoreSettingsToUI();

    // Cập nhật tức thì chữ và mã QR trên hóa đơn đang mở
    document.getElementById('bill-store-name').innerText = storeSettings.storeName.toUpperCase();
    document.getElementById('bill-store-phone').innerText = storeSettings.phone || "---";
    document.getElementById('bill-store-address').innerText = storeSettings.address || "";

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
}

// Hàm gọi lệnh in AirPrint siêu tốc trên iPhone (Dùng setTimeout giải phóng UI thread chống đơ/lag)
function triggerFastAirPrint() {
    const editBox = document.getElementById('quick-bill-edit-box');
    if (editBox) editBox.classList.add('hidden');
    setTimeout(() => {
        window.print();
    }, 120);
}

// Bật/tắt khung sửa nhanh Tên cửa hàng, SĐT & Tài khoản QR ngay trên đầu Hóa đơn
function toggleQuickBillHeaderEdit() {
    const box = document.getElementById('quick-bill-edit-box');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
        document.getElementById('qb-store-name').value = storeSettings.storeName || "Tạp Hóa Huy Hoàng";
        document.getElementById('qb-store-phone').value = storeSettings.phone || "";
        document.getElementById('qb-store-address').value = storeSettings.address || "";
        document.getElementById('qb-bank-id').value = storeSettings.bankId || "MB";
        document.getElementById('qb-bank-acc').value = storeSettings.bankAcc || "";
        document.getElementById('qb-bank-owner').value = storeSettings.bankOwner || "";
    }
}

// Gõ sửa tới đâu cập nhật ngay lên tờ Hóa đơn & lưu cấu hình tới đó
function applyQuickBillHeaderEdit() {
    storeSettings.storeName = document.getElementById('qb-store-name').value.trim() || "Tạp Hóa Huy Hoàng";
    storeSettings.phone = document.getElementById('qb-store-phone').value.trim();
    storeSettings.address = document.getElementById('qb-store-address').value.trim();
    storeSettings.bankId = document.getElementById('qb-bank-id').value;
    storeSettings.bankAcc = document.getElementById('qb-bank-acc').value.trim();
    storeSettings.bankOwner = document.getElementById('qb-bank-owner').value.trim().toUpperCase();

    localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
    db.collection("shop_data").doc("settings").set(storeSettings).catch(() => {});
    if (typeof applyStoreSettingsToUI === 'function') applyStoreSettingsToUI();

    // Cập nhật tức thì chữ và mã QR trên hóa đơn đang mở
    document.getElementById('bill-store-name').innerText = storeSettings.storeName.toUpperCase();
    document.getElementById('bill-store-phone').innerText = storeSettings.phone || "---";
    document.getElementById('bill-store-address').innerText = storeSettings.address || "";

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
}

function openPrintableInvoice(order) {
    currentViewingOrder = order;
    setInvoicePrintMode(storeSettings.printSize || 'A5');
    document.getElementById('quick-bill-edit-box')?.classList.add('hidden');

    document.getElementById('bill-store-name').innerText = (storeSettings.storeName || "TẠP HÓA HUY HOÀNG").toUpperCase();
    document.getElementById('bill-store-phone').innerText = storeSettings.phone || "---";
    document.getElementById('bill-store-address').innerText = storeSettings.address || "";

    document.getElementById('bill-title-type').innerText = order.orderType === 'RETURN' ? 'PHIẾU HOÀN TRẢ HÀNG' : 'HÓA ĐƠN BÁN HÀNG';
    document.getElementById('bill-detail-id').innerText = order.orderCode;
    document.getElementById('bill-detail-date').innerText = new Date(order.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
    document.getElementById('bill-detail-seller').innerText = order.seller || "Chủ Quán";

    const snap = order.customerSnapshot || { name: "Khách Lẻ", phone: "", address: "" };
    document.getElementById('bill-cust-name').innerText = snap.name || "Khách Lẻ";
    document.getElementById('bill-cust-phone').innerText = snap.phone || "Không SĐT";
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

    const btnRet = document.getElementById('btn-open-return-from-bill');
    if (order.orderType === 'RETURN') btnRet.classList.add('hidden');
    else btnRet.classList.remove('hidden');

    document.getElementById('bill-detail-modal').classList.remove('hidden');
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
                <td class="p-3 text-xs text-slate-600 max-w-xs truncate mobile-hide-col" title="${itemsText}">${itemsText}</td>
                <td class="p-3 text-right font-black ${isReturn ? 'text-purple-700' : 'text-slate-800'}">${formatmoney(ord.totalAmount)} đ</td>
                <td class="p-3 text-right font-semibold text-emerald-600 mobile-hide-col">${formatmoney(ord.paidAmount || 0)} đ</td>
                <td class="p-3 text-right font-bold text-red-600">${formatmoney(ord.newDebt || 0)} đ</td>
                <td class="p-3 text-center whitespace-nowrap">
                    <button onclick="openPrintableInvoice(ordersList[${idx}])" title="Xem & In hóa đơn" class="px-2.5 py-1.5 bg-blue-50 hover:bg-inni-blue text-inni-blue hover:text-white rounded-lg text-xs font-bold transition scale-active mr-1">
                        <i class="fa-solid fa-print"></i> In
                    </button>
                    <button onclick="copyOrderToPos(ordersList[${idx}])" title="Sao chép toàn bộ mặt hàng trong đơn này ra POS" class="px-2.5 py-1.5 bg-amber-50 hover:bg-amber-500 text-amber-700 hover:text-white rounded-lg text-xs font-bold transition scale-active mr-1">
                        <i class="fa-solid fa-copy"></i> Sao Chép Đơn
                    </button>
                    ${!isReturn ? `
                    <button onclick="openReturnOrderModal(ordersList[${idx}])" title="Khách trả lại hàng lỗi/móp" class="px-2.5 py-1.5 bg-purple-50 hover:bg-purple-600 text-purple-700 hover:text-white rounded-lg text-xs font-bold transition scale-active">
                        <i class="fa-solid fa-rotate-left"></i> Hoàn Hàng
                    </button>` : ''}
                </td>
            </tr>
        `;
    });

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

        // 2. Đảo ngược công nợ khách hàng & Xóa lịch sử nợ của đơn này
        if (ord.customerId && ord.customerId !== 'GUEST') {
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
            "Tên khách hàng": "Tạp hóa Cô Tư",
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

async function loadReportsModule() {
    const fromStr = document.getElementById('rep-date-from')?.value || '2024-01-01';
    const toStr = document.getElementById('rep-date-to')?.value || '2060-12-31';
    const tbody = document.getElementById('rep-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tính toán báo cáo Lãi/Lỗ...</td></tr>`;

    try {
        const snap = await db.collection("orders")
            .where("dateStr", ">=", fromStr)
            .where("dateStr", "<=", toStr)
            .get();

        // Chỉ tính các đơn xuất bán còn hiệu lực (các đơn đã hoàn 100% có totalAmount = 0 sẽ tự động không tính)
        const salesOrders = snap.docs.map(d => d.data()).filter(o => o.orderType === 'SALE' && (Number(o.totalAmount) || 0) > 0);
        let netRev = 0, totalCost = 0;
        const itemMap = {};

        salesOrders.forEach(ord => {
            netRev += Number(ord.totalAmount) || 0;
            totalCost += Number(ord.totalCost) || 0;

            (ord.items || []).forEach(i => {
                if ((Number(i.qty) || 0) <= 0) return;
                if (!itemMap[i.productName]) {
                    itemMap[i.productName] = { baseUnit: i.baseUnit || 'ĐV', baseQty: 0, rev: 0, cost: 0 };
                }
                itemMap[i.productName].baseQty += Number(i.baseQty) || 0;
                itemMap[i.productName].rev += Number(i.totalPrice) || 0;
                itemMap[i.productName].cost += Number(i.totalCost) || 0;
            });
        });

        const grossProfit = netRev - totalCost;
        document.getElementById('rep-stat-rev').innerText = `${formatmoney(netRev)} đ`;
        document.getElementById('rep-stat-cost').innerText = `${formatmoney(totalCost)} đ`;
        document.getElementById('rep-stat-profit').innerText = `${formatmoney(grossProfit)} đ`;
        document.getElementById('rep-stat-orders').innerText = `${salesOrders.length} đơn`;

        const sortedNames = Object.keys(itemMap).sort((a, b) => (itemMap[b].rev - itemMap[b].cost) - (itemMap[a].rev - itemMap[a].cost));
        tbody.innerHTML = '';

        if (sortedNames.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400 italic">Chưa có dữ liệu bán hàng trong kỳ này.</td></tr>`;
            return;
        }

        sortedNames.forEach(name => {
            const st = itemMap[name];
            const profit = st.rev - st.cost;
            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-3 font-bold text-slate-800">${name}</td>
                    <td class="p-3 text-center font-semibold">${st.baseQty} ${st.baseUnit}</td>
                    <td class="p-3 text-right font-bold text-inni-blue">${formatmoney(st.rev)} đ</td>
                    <td class="p-3 text-right text-slate-600">${formatmoney(st.cost)} đ</td>
                    <td class="p-3 text-right font-black text-emerald-600">+${formatmoney(profit)} đ</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-red-500">Lỗi báo cáo: ${e.message}</td></tr>`;
    }
}