// ==========================================
// 1. KHỞI TẠO FIREBASE & BỘ NHỚ ĐỆM CHỐNG TRÀN QUOTA
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyDPdxOqQiGA3uhCtctfM17mLdwnIryOYkM",
    authDomain: "inni-shop.firebaseapp.com",
    projectId: "inni-shop",
    storageBucket: "inni-shop.firebasestorage.app",
    messagingSenderId: "162996670712",
    appId: "1:162996670712:web:188d90a03ba81759c42b0d",
    measurementId: "G-6CP67CR75J"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
    console.warn("Cache Persistence notice:", err.code);
});

const CATEGORIES = [
    "Gia vị & Nước chấm", "Mì & Đồ ăn liền", "Snack & Bim bim", "Bánh kẹo & Socola",
    "Sữa & Chế phẩm sữa", "Trà & Cà phê", "Nước giải khát & Nước lọc", "Bia & Rượu",
    "Kem & Đông lạnh", "Đồ khô & Đóng gói", "Thuốc lá & Phụ kiện", "Chăm sóc cá nhân",
    "Vệ sinh nhà cửa", "Đồ dùng gia đình & Tiện ích", "Khác"
];

let inventory = [];
let currentViewingProductId = null;
let html5QrCode = null;
let currentPoItems = []; // Danh sách mặt hàng trong 1 chuyến nhập kho

const DEFAULT_STORE_SETTINGS = {
    storeName: "Đại Lý HỒNG ĐIỆP",
    phone: "0909.xxx.xxx",
    address: "Đồng Nai",
    printSize: "A5",
    bankId: "MB",
    bankAcc: "",
    bankOwner: ""
};

let storeSettings = (() => {
    try {
        const saved = JSON.parse(localStorage.getItem('hh_store_settings') || 'null');
        return (saved && typeof saved === 'object') ? { ...DEFAULT_STORE_SETTINGS, ...saved } : { ...DEFAULT_STORE_SETTINGS };
    } catch (e) {
        return { ...DEFAULT_STORE_SETTINGS };
    }
})();

// Đồng bộ bền vững cấu hình cửa hàng & mã QR từ Firestore (chống mất cấu hình khi reload / mở PWA)
function initStoreSettingsPersistence() {
    db.collection("shop_data").doc("settings").onSnapshot((docSnap) => {
        if (docSnap.exists) {
            const cloudData = docSnap.data();
            if (cloudData && typeof cloudData === 'object') {
                storeSettings = { ...DEFAULT_STORE_SETTINGS, ...storeSettings, ...cloudData };
                localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
                applyStoreSettingsToUI();
            }
        } else {
            // Nếu trên Cloud chưa có bản ghi nhưng máy đã lưu, đẩy lên Cloud để giữ bền vững
            const hasLocal = localStorage.getItem('hh_store_settings');
            if (hasLocal) {
                db.collection("shop_data").doc("settings").set(storeSettings, { merge: true }).catch(() => {});
            }
        }
    }, (err) => {
        console.warn("Không thể tải cấu hình từ Cloud, dùng cấu hình đã lưu tại máy:", err);
    });
}

// ==========================================
// 2. HÀM TIỆN ÍCH DÙNG CHUNG & CAMERA BARCODE SCANNER
// ==========================================
window.addEventListener('load', () => {
    initCategorySelects();
    applyStoreSettingsToUI();
    initStoreSettingsPersistence();
    initInventoryInfiniteScroll();
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.classList.add('splash-fade-out');
            setTimeout(() => splash.remove(), 400);
        }
    }, 1000);
});

function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1200, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
    } catch (e) {}
}

function startBarcodeScanner(targetInputId, customCallback = null) {
    const modal = document.getElementById('barcode-scanner-modal');
    modal.classList.remove('hidden');

    if (html5QrCode) {
        html5QrCode.stop().catch(() => {});
    }
    html5QrCode = new Html5Qrcode("qr-reader");

    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 140 } },
        (decodedText) => {
            playBeepSound();
            stopBarcodeScanner();
            if (customCallback) {
                customCallback(decodedText);
            } else if (targetInputId) {
                const inputEl = typeof targetInputId === 'string' ? document.getElementById(targetInputId) : targetInputId;
                if (inputEl) {
                    inputEl.value = decodedText;
                    inputEl.dispatchEvent(new Event('input'));
                }
            }
        },
        () => {}
    ).catch(err => {
        alert("Không thể mở Camera (Hãy cấp quyền Camera hoặc mở qua HTTPS/GitHub Pages): " + err);
        stopBarcodeScanner();
    });
}

function stopBarcodeScanner() {
    const modal = document.getElementById('barcode-scanner-modal');
    modal.classList.add('hidden');
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            html5QrCode.clear();
            html5QrCode = null;
        }).catch(() => {});
    }
}

function formatmoney(num) {
    return (Math.round(num) || 0).toLocaleString('vi-VN').replace(/,/g, '.');
}

function formatCurrencyInput(input) {
    let val = input.value.replace(/\./g, '').replace(/\D/g, '');
    input.value = val === '' ? '' : parseInt(val, 10).toLocaleString('vi-VN').replace(/,/g, '.');
}

function getRawNum(idOrEl) {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!el || !el.value) return 0;
    return parseInt(el.value.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;
}

function compressImage(base64Str, maxWidth = 250) {
    return new Promise((resolve) => {
        if (!base64Str) return resolve(null);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width, height = img.height;
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = () => resolve(base64Str);
        img.src = base64Str;
    });
}

function initCategorySelects() {
    const invCat = document.getElementById('inv-search-cat');
    const prodCat = document.getElementById('prod-category');
    const sellCat = document.getElementById('sell-search-cat');
    
    CATEGORIES.forEach(cat => {
        if (invCat) invCat.innerHTML += `<option value="${cat}">${cat}</option>`;
        if (prodCat) prodCat.innerHTML += `<option value="${cat}">${cat}</option>`;
        if (sellCat) sellCat.innerHTML += `<option value="${cat}">${cat}</option>`;
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden');
        el.classList.remove('animate-fade-in');
    });
    const target = document.getElementById(tabId);
    if (target) {
        target.classList.remove('hidden');
        void target.offsetWidth;
        target.classList.add('animate-fade-in');
    }

    document.querySelectorAll('.desktop-nav-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white');
        btn.classList.add('text-slate-300');
    });
    const deskBtn = document.getElementById('btn-' + tabId);
    if (deskBtn) {
        deskBtn.classList.remove('text-slate-300');
        deskBtn.classList.add('bg-blue-600', 'text-white');
    }

    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.remove('text-inni-blue', 'font-bold');
        btn.classList.add('text-slate-400');
    });
    const mobBtn = document.getElementById('btn-mobile-' + tabId);
    if (mobBtn) {
        mobBtn.classList.remove('text-slate-400');
        mobBtn.classList.add('text-inni-blue', 'font-bold');
    }

    if (tabId === 'tab-inventory') renderInventory();
}

// ==========================================
// 3. LẮNG NGHE DỮ LIỆU KHO HÀNG (CÓ GIÁ LẺ & GIÁ SỈ)
// ==========================================
db.collection("inventory").onSnapshot((snapshot) => {
    inventory = snapshot.docs.map(doc => {
        const d = doc.data();
        const basePrice = Number(d.basePrice ?? d.price ?? 0);
        const wholesalePrice = Number(d.wholesalePrice ?? basePrice);
        const baseUnit = d.baseUnit || "Cái";
        return {
            id: doc.id,
            name: d.name || "Chưa đặt tên",
            category: d.category || "Khác",
            barcode: d.barcode || "",
            keywords: Array.isArray(d.keywords) ? d.keywords : [],
            image: d.image || null,
            baseUnit: baseUnit,
            basePrice: basePrice,
            wholesalePrice: wholesalePrice,
            price: basePrice,
            costPrice: Number(d.costPrice ?? Math.round(basePrice * 0.85)),
            stock: Number(d.stock ?? 0),
            minStock: Number(d.minStock ?? 10),
            units: Array.isArray(d.units) && d.units.length > 0 ? d.units : [
                { unitName: baseUnit, conversionRate: 1, sellingPrice: basePrice, wholesalePrice: wholesalePrice, barcode: d.barcode || "" }
            ],
            createdAt: d.createdAt || 0
        };
    });
    inventory.sort((a, b) => b.createdAt - a.createdAt);
    renderInventory();
    if (typeof renderSellGrid === 'function') renderSellGrid();
});

// ==========================================
// 4. HIỂN THỊ KHO HÀNG & ĐA ĐƠN VỊ TÍNH
// ==========================================
// Tách tổng số đơn vị nhỏ ra thành các đơn vị lớn -> nhỏ (VD: 1095 Lon -> 45 Thùng, 2 Lốc, 3 Lon)
function breakdownStockByUnits(totalBaseStock, units) {
    let remaining = Math.max(0, totalBaseStock);
    const sortedUnits = [...units].sort((a, b) => b.conversionRate - a.conversionRate);
    return sortedUnits.map(u => {
        const count = Math.floor(remaining / u.conversionRate);
        remaining = remaining % u.conversionRate;
        return { unitName: u.unitName, conversionRate: u.conversionRate, count };
    });
}

function formatStockMultiUnit(item) {
    const stock = item.stock;
    if (stock <= 0) return `<span class="text-red-600 font-black">Hết hàng (${stock})</span>`;
    
    const largeUnits = item.units.filter(u => u.conversionRate > 1);
    if (largeUnits.length > 0) {
        const parts = breakdownStockByUnits(stock, item.units).filter(p => p.count > 0);
        const breakdownStr = parts.map(p => `${p.count} ${p.unitName}`).join(' + ');
        return `<div class="font-black text-slate-800">${stock} ${item.baseUnit}</div>
                <div class="text-[11px] text-emerald-700 font-semibold">(= ${breakdownStr})</div>`;
    }
    return `<span class="font-black text-slate-800">${stock} ${item.baseUnit}</span>`;
}

function toggleLowStockFilter() {
    const sel = document.getElementById('inv-filter-stock');
    sel.value = sel.value === 'low' ? 'all' : 'low';
    renderInventory();
}

let invRenderLimit = 40;

function loadMoreInventory() {
    invRenderLimit += 40;
    renderInventory(false);
}

function openMobileProductActionSheet(prodId) {
    const item = inventory.find(i => i.id === prodId);
    if (!item) return;
    const choice = prompt(
        `THAO TÁC: ${item.name}\nNhập số để chọn:\n1 - Sửa sản phẩm\n2 - Kiểm kho / Xem thẻ kho\n3 - Xóa sản phẩm`,
        "1"
    );
    if (choice === "1") openProductModal(prodId);
    else if (choice === "2") openStockCardModal(prodId);
    else if (choice === "3") deleteProduct(prodId);
}

function renderInventory(resetLimit = true) {
    if (resetLimit) invRenderLimit = 40;
    const tbody = document.getElementById('inventory-list');
    const mobList = document.getElementById('inventory-mobile-list');
    const noRes = document.getElementById('inv-no-result');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (mobList) mobList.innerHTML = '';

    const search = (document.getElementById('inv-search-name')?.value || '').toLowerCase().trim();
    const catFilter = document.getElementById('inv-search-cat')?.value || 'all';
    const stockFilter = document.getElementById('inv-filter-stock')?.value || 'all';

    let totalItems = inventory.length;
    let totalCapital = 0;
    let totalRetail = 0;
    let lowStockCount = 0;
    let renderedCount = 0;

    inventory.forEach(item => {
        if (item.stock > 0) {
            totalCapital += item.stock * item.costPrice;
            totalRetail += item.stock * item.basePrice;
        }
        const isLow = item.stock <= item.minStock;
        if (isLow) lowStockCount++;

        const matchBarcodeUnit = item.units.some(u => u.barcode && u.barcode.toLowerCase().includes(search));
        const matchSearch = !search || 
            item.name.toLowerCase().includes(search) || 
            (item.barcode && item.barcode.toLowerCase().includes(search)) ||
            matchBarcodeUnit ||
            item.keywords.some(k => k.toLowerCase().includes(search));
        if (!matchSearch) return;
        if (catFilter !== 'all' && item.category !== catFilter) return;
        if (stockFilter === 'low' && !isLow) return;
        if (stockFilter === 'out' && item.stock > 0) return;

        renderedCount++;
        if (renderedCount > invRenderLimit) return;

        // 1. Dữ liệu cho bảng PC
        const imgTag = item.image 
            ? `<img src="${item.image}" class="w-11 h-11 object-contain rounded-lg border bg-white p-0.5">`
            : `<div class="w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400"><i class="fa-solid fa-image"></i></div>`;

        const retailHtml = `
            <div class="font-black text-red-600 text-sm">Lẻ: ${formatmoney(item.basePrice)}đ <span class="text-[10px] font-normal text-slate-500">/${item.baseUnit}</span></div>
            <div class="font-bold text-inni-blue text-xs mt-0.5">Sỉ: ${formatmoney(item.wholesalePrice || item.basePrice)}đ <span class="text-[10px] font-normal text-slate-500">/${item.baseUnit}</span></div>
        `;

        const wholesaleUnits = item.units.filter(u => u.conversionRate > 1);
        const wholesaleHtml = wholesaleUnits.length > 0
            ? wholesaleUnits.map(u => `
                <div class="mb-1 last:mb-0 bg-blue-50/80 border border-blue-200 px-2.5 py-1 rounded-lg flex items-center justify-between gap-2">
                    <span class="text-xs font-bold text-slate-700">1 ${u.unitName} <span class="text-[10px] text-slate-500 font-normal">(${u.conversionRate} ${item.baseUnit})</span></span>
                    <div class="text-right leading-tight whitespace-nowrap">
                        <span class="font-bold text-red-600 text-[11px] block">Lẻ: ${formatmoney(u.sellingPrice)}đ</span>
                        <span class="font-black text-inni-blue text-xs block">Sỉ: ${formatmoney(u.wholesalePrice || u.sellingPrice)}đ</span>
                    </div>
                </div>
            `).join('')
            : `<span class="text-xs text-slate-400 italic">Chỉ bán theo ${item.baseUnit}</span>`;

        const rowBg = isLow ? "bg-red-50/70 hover:bg-red-100/60" : "hover:bg-blue-50/40";
        const lowBadge = isLow 
            ? `<span class="ml-1.5 px-1.5 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded">Cảnh báo tồn (<=${item.minStock})</span>` 
            : '';

        const tr = document.createElement('tr');
        tr.className = `transition ${rowBg}`;
        tr.innerHTML = `
            <td class="p-3">${imgTag}</td>
            <td class="p-3">
                <div class="font-bold text-slate-800 flex items-center flex-wrap">${item.name}${lowBadge}</div>
                <div class="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span class="bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-semibold">${item.category}</span>${item.barcode ? `<span><i class="fa-solid fa-barcode"></i> ${item.barcode}</span>` : ''}
                </div>
            </td>
            <td class="p-3 text-right font-semibold text-slate-600">${formatmoney(item.costPrice)} đ<span class="text-[10px] text-slate-400 block">/${item.baseUnit}</span></td>
            <td class="p-3 text-right bg-red-50/20">${retailHtml}</td>
            <td class="p-3 bg-blue-50/20">${wholesaleHtml}</td>
            <td class="p-3 text-center">${formatStockMultiUnit(item)}</td>
            <td class="p-3 text-center">
                <div class="flex justify-center gap-1.5">
                    <button onclick="openStockCardModal('${item.id}')" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-amber-300 rounded-lg text-xs font-bold flex items-center gap-1 shadow-sm scale-active">
                        <i class="fa-solid fa-clipboard-check"></i> Kiểm Kho / Thẻ
                    </button>
                    <button onclick="openProductModal('${item.id}')" class="w-8 h-8 bg-amber-50 hover:bg-amber-500 text-amber-600 hover:text-white rounded-lg flex items-center justify-center transition scale-active border border-amber-200">
                        <i class="fa-solid fa-pen text-xs"></i>
                    </button>
                    <button onclick="deleteProduct('${item.id}')" class="w-8 h-8 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-lg flex items-center justify-center transition scale-active border border-red-200">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);

        // 2. Dữ liệu Thẻ Sản Phẩm (List Item 1 dòng chuẩn Sapo) trên Mobile (< 768px)
        if (mobList) {
            let stockConvertedStr = `${item.stock} ${item.baseUnit}`;
            if (item.stock <= 0) {
                stockConvertedStr = `Hết hàng (0)`;
            } else if (item.units.some(u => u.conversionRate > 1)) {
                const parts = breakdownStockByUnits(item.stock, item.units).filter(p => p.count > 0);
                stockConvertedStr = parts.map(p => `${p.count} ${p.unitName}`).join(' ');
            }

            const mobThumb = item.image
                ? `<img src="${item.image}" class="w-10 h-10 rounded-lg object-cover border border-slate-200 shrink-0">`
                : `<div class="w-10 h-10 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center shrink-0 text-xs"><i class="fa-solid fa-box"></i></div>`;

            mobList.innerHTML += `
                <div class="flex items-center justify-between px-3.5 py-3 gap-2.5 active:bg-slate-50" onclick="openProductModal('${item.id}')">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        ${mobThumb}
                        <div class="min-w-0 flex-1">
                            <div class="font-bold text-slate-800 text-[13px] truncate">${item.name}</div>
                            <div class="text-[11px] text-slate-400 truncate mt-0.5">${item.barcode || 'Chưa có SKU'}</div>
                        </div>
                    </div>
                    <div class="text-right shrink-0">
                        <div class="font-bold text-[13px] ${item.stock <= 0 ? 'text-red-600' : 'text-slate-800'}">${stockConvertedStr}</div>
                        <div class="text-[11px] text-slate-500 mt-0.5">
                            Lẻ: <b class="text-slate-700">${formatmoney(item.basePrice)}</b> • Sỉ: <b class="text-[#0088FF]">${formatmoney(item.wholesalePrice || item.basePrice)}</b>
                        </div>
                    </div>
                    <button type="button" onclick="event.stopPropagation(); openMobileProductActionSheet('${item.id}')" class="w-7 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 shrink-0 -mr-1">
                        <i class="fa-solid fa-ellipsis-vertical"></i>
                    </button>
                </div>
            `;
        }
    });

    document.getElementById('inv-stat-total').innerText = `${totalItems} mặt hàng`;
    document.getElementById('inv-stat-capital').innerText = `${formatmoney(totalCapital)} đ`;
    document.getElementById('inv-stat-low').innerText = `${lowStockCount} món`;
    document.getElementById('inv-stat-retail').innerText = `${formatmoney(totalRetail)} đ`;

    const mobCntEl = document.getElementById('inv-mobile-count-label');
    if (mobCntEl) mobCntEl.innerText = `${renderedCount} sản phẩm`;
    const loadMoreWrap = document.getElementById('inv-load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.classList.toggle('hidden', renderedCount <= invRenderLimit);

    const badgeDesk = document.getElementById('badge-low-stock');
    const badgeMob = document.getElementById('badge-mobile-low-stock');
    if (lowStockCount > 0) {
        if (badgeDesk) { badgeDesk.innerText = lowStockCount; badgeDesk.classList.remove('hidden'); }
        if (badgeMob) badgeMob.classList.remove('hidden');
    } else {
        if (badgeDesk) badgeDesk.classList.add('hidden');
        if (badgeMob) badgeMob.classList.add('hidden');
    }

    if (renderedCount === 0) noRes.classList.remove('hidden');
    else noRes.classList.add('hidden');
}

// --- THÊM / SỬA MẶT HÀNG ĐA ĐƠN VỊ (MA TRẬN GIÁ LẺ & GIÁ SỈ CHO TỪNG CẤP ĐƠN VỊ) ---
function addUnitRow(unitName = '', conversionRate = '', sellingPrice = '', wholesalePrice = '', barcode = '') {
    const container = document.getElementById('unit-rows-container');
    const div = document.createElement('div');
    div.className = "grid grid-cols-12 gap-1.5 items-center unit-row bg-white p-2 rounded-lg border border-blue-200 shadow-sm";
    div.innerHTML = `
        <div class="col-span-2">
            <input type="text" placeholder="Lốc, Thùng..." value="${unitName}" class="unit-name w-full border border-slate-300 p-1.5 rounded text-xs font-bold text-slate-800">
        </div>
        <div class="col-span-2">
            <input type="number" placeholder="VD: 6, 24" value="${conversionRate}" class="unit-rate w-full border border-slate-300 p-1.5 rounded text-xs text-center font-bold text-emerald-700">
        </div>
        <div class="col-span-3">
            <input type="text" oninput="formatCurrencyInput(this)" placeholder="Giá lẻ (${unitName || 'ĐV'})" value="${sellingPrice ? formatmoney(sellingPrice) : ''}" class="unit-price w-full border-2 border-red-300 focus:border-red-500 p-1.5 rounded text-xs font-black text-red-600">
        </div>
        <div class="col-span-3">
            <input type="text" oninput="formatCurrencyInput(this)" placeholder="Giá sỉ (${unitName || 'ĐV'})" value="${wholesalePrice ? formatmoney(wholesalePrice) : ''}" class="unit-wholesale-price w-full border-2 border-blue-400 focus:border-inni-blue p-1.5 rounded text-xs font-black text-inni-blue">
        </div>
        <div class="col-span-2 flex items-center gap-1">
            <input type="text" placeholder="Mã" value="${barcode}" class="unit-barcode w-full border border-slate-300 p-1.5 rounded text-xs min-w-0">
            <button type="button" onclick="startBarcodeScanner(this.previousElementSibling)" title="Quét mã vạch" class="bg-slate-800 text-amber-400 px-1.5 py-1.5 rounded text-[10px] shrink-0"><i class="fa-solid fa-camera"></i></button>
            <button type="button" onclick="this.closest('.unit-row').remove()" title="Xóa đơn vị này" class="text-red-400 hover:text-red-600 px-1 shrink-0"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    `;
    container.appendChild(div);
}

function openProductModal(id = null) {
    document.getElementById('unit-rows-container').innerHTML = '';
    document.getElementById('prod-image').value = '';

    if (!id) {
        document.getElementById('prod-modal-title').innerHTML = `<i class="fa-solid fa-plus-circle mr-2"></i>Thêm Mặt Hàng Bán Sỉ Mới`;
        document.getElementById('prod-id').value = '';
        document.getElementById('prod-name').value = '';
        document.getElementById('prod-keywords').value = '';
        document.getElementById('prod-barcode').value = '';
        document.getElementById('prod-base-unit').value = 'Lon';
        document.getElementById('prod-cost-price').value = '';
        document.getElementById('prod-base-price').value = '';
        document.getElementById('prod-wholesale-price').value = '';
        document.getElementById('prod-stock').value = '0';
        document.getElementById('prod-min-stock').value = '24';
        // Mở sẵn Cấp 2 (Lốc = 6) và Cấp 3 (Thùng = 24)
        addUnitRow('Lốc', 6, '', '', '');
        addUnitRow('Thùng', 24, '', '', '');
    } else {
        const item = inventory.find(i => i.id === id);
        if (!item) return;
        document.getElementById('prod-modal-title').innerHTML = `<i class="fa-solid fa-pen-to-square mr-2"></i>Cập Nhật: ${item.name}`;
        document.getElementById('prod-id').value = item.id;
        document.getElementById('prod-name').value = item.name;
        document.getElementById('prod-category').value = item.category;
        document.getElementById('prod-keywords').value = item.keywords.join(', ');
        document.getElementById('prod-barcode').value = item.barcode || '';
        document.getElementById('prod-base-unit').value = item.baseUnit;
        document.getElementById('prod-cost-price').value = formatmoney(item.costPrice);
        document.getElementById('prod-base-price').value = formatmoney(item.basePrice);
        document.getElementById('prod-wholesale-price').value = formatmoney(item.wholesalePrice || item.basePrice);
        document.getElementById('prod-stock').value = item.stock;
        document.getElementById('prod-min-stock').value = item.minStock;

        const wholesaleUnits = item.units.filter(u => u.conversionRate > 1);
        if (wholesaleUnits.length > 0) {
            wholesaleUnits.forEach(u => addUnitRow(
                u.unitName,
                u.conversionRate,
                u.sellingPrice,
                u.wholesalePrice ?? u.sellingPrice,
                u.barcode || ''
            ));
        } else {
            addUnitRow('Lốc', 6, '', '', '');
            addUnitRow('Thùng', 24, '', '', '');
        }
    }
    document.getElementById('product-modal').classList.remove('hidden');
}

function closeProductModal() {
    document.getElementById('product-modal').classList.add('hidden');
}

async function saveProduct() {
    const id = document.getElementById('prod-id').value;
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value;
    const keywordsRaw = document.getElementById('prod-keywords').value;
    const barcode = document.getElementById('prod-barcode').value.trim();
    const baseUnit = document.getElementById('prod-base-unit').value.trim() || 'Cái';
    const costPrice = getRawNum('prod-cost-price');
    const basePrice = getRawNum('prod-base-price');
    const wholesalePrice = getRawNum('prod-wholesale-price') || basePrice;
    const stock = parseInt(document.getElementById('prod-stock').value, 10) || 0;
    const minStock = parseInt(document.getElementById('prod-min-stock').value, 10) || 0;
    const imageInput = document.getElementById('prod-image');

    if (!name || basePrice <= 0) {
        return alert("Vui lòng nhập Tên sản phẩm và Giá bán lẻ hợp lệ!");
    }

    const keywords = keywordsRaw.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    const units = [{ unitName: baseUnit, conversionRate: 1, sellingPrice: basePrice, wholesalePrice: wholesalePrice, barcode: barcode }];

    document.querySelectorAll('#unit-rows-container .unit-row').forEach(row => {
        const uName = row.querySelector('.unit-name').value.trim();
        const uRate = parseInt(row.querySelector('.unit-rate').value, 10) || 0;
        const uRetailPrice = getRawNum(row.querySelector('.unit-price'));
        const uWholesalePrice = getRawNum(row.querySelector('.unit-wholesale-price'));
        const uBarcode = row.querySelector('.unit-barcode').value.trim();
        if (uName && uRate > 1 && (uRetailPrice > 0 || uWholesalePrice > 0)) {
            const finalRetail = uRetailPrice > 0 ? uRetailPrice : uWholesalePrice;
            const finalWholesale = uWholesalePrice > 0 ? uWholesalePrice : uRetailPrice;
            units.push({
                unitName: uName,
                conversionRate: uRate,
                sellingPrice: finalRetail,
                wholesalePrice: finalWholesale,
                barcode: uBarcode
            });
        }
    });

    const btn = document.getElementById('btn-save-product');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;

    const productData = {
        name, category, keywords, barcode, baseUnit,
        costPrice: costPrice > 0 ? costPrice : Math.round(basePrice * 0.85),
        basePrice, wholesalePrice, price: basePrice,
        stock, minStock, units
    };

    if (imageInput.files.length > 0) {
        const rawB64 = await new Promise(res => {
            const reader = new FileReader();
            reader.onload = e => res(e.target.result);
            reader.readAsDataURL(imageInput.files[0]);
        });
        productData.image = await compressImage(rawB64, 250);
    }

    try {
        if (!id) {
            productData.createdAt = Date.now();
            const docRef = await db.collection("inventory").add(productData);
            if (stock > 0) {
                await writeInventoryLog(docRef.id, name, "IMPORT", "KHỞI-TẠO", `${stock} ${baseUnit}`, 0, stock, stock);
            }
        } else {
            const oldItem = inventory.find(i => i.id === id);
            await db.collection("inventory").doc(id).update(productData);
            if (oldItem && oldItem.stock !== stock) {
                const diff = stock - oldItem.stock;
                await writeInventoryLog(id, name, "ADJUST", "SỬA-TỒN", `${diff > 0 ? '+' : ''}${diff} ${baseUnit}`, oldItem.stock, diff, stock);
            }
        }
        closeProductModal();
    } catch (e) {
        alert("Lỗi khi lưu: " + e.message);
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Lưu Mặt Hàng`;
}

function deleteProduct(id) {
    const item = inventory.find(i => i.id === id);
    if (confirm(`Xóa mặt hàng "${item ? item.name : ''}" khỏi kho?`)) {
        db.collection("inventory").doc(id).delete();
    }
}

// ==========================================
// 5. THẺ KHO & KIỂM KHO THÔNG MINH (ĐẾM THEO THÙNG / LỐC / LON)
// ==========================================
async function writeInventoryLog(productId, productName, actionType, referenceId, unitDisplay, startStock, changeQty, endStock) {
    return db.collection("inventory_logs").add({
        productId, productName, actionType, referenceId, unitDisplay,
        startStock, changeQty, endStock,
        createdAt: Date.now()
    });
}

async function openStockCardModal(productId) {
    currentViewingProductId = productId;
    const item = inventory.find(i => i.id === productId);
    if (!item) return;

    document.getElementById('sc-prod-name').innerText = item.name;
    document.getElementById('sc-prod-summary').innerText = `Tồn sổ sách hiện tại: ${item.stock} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
    document.getElementById('sc-adjust-note').value = '';

    renderSmartStocktakeInputs(item, false);
    document.getElementById('stock-card-modal').classList.remove('hidden');

    loadStockCardLogs(productId, item.baseUnit);
}

// Sinh các ô nhập số lượng đếm thực tế từ Đơn vị lớn nhất -> nhỏ nhất (VD: Ô 1: Thùng, Ô 2: Lốc, Ô 3: Lon)
function renderSmartStocktakeInputs(item, setAllZero = false) {
    const container = document.getElementById('sc-multi-unit-inputs');
    if (!container) return;

    const breakdown = breakdownStockByUnits(setAllZero ? 0 : item.stock, item.units);
    container.innerHTML = breakdown.map((b, idx) => `
        <div class="bg-white p-2.5 rounded-xl border-2 border-amber-300 shadow-sm">
            <label class="block text-[11px] font-black text-slate-700 mb-1">
                Ô ${idx + 1}: Số ${b.unitName} <span class="text-slate-400 font-normal">(×${b.conversionRate} ${item.baseUnit})</span>
            </label>
            <input type="number" min="0" value="${setAllZero ? '' : b.count}" placeholder="0"
                data-unit-name="${b.unitName}" data-rate="${b.conversionRate}"
                oninput="calcSmartStocktakePreview()"
                class="sc-unit-qty-inp w-full border border-slate-300 rounded-lg p-1.5 text-base font-black text-inni-blue text-center focus:outline-none focus:border-inni-blue bg-amber-50/30 focus:bg-white">
        </div>
    `).join('');

    calcSmartStocktakePreview();
}

function resetSmartStocktakeZero() {
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return;
    renderSmartStocktakeInputs(item, true);
    const firstInp = document.querySelector('.sc-unit-qty-inp');
    if (firstInp) firstInp.focus();
}

// Tự động nhẩm toán (45 x 24) + (2 x 6) + 3 = 1095 Lon & So sánh Hao hụt / Dư thừa
function calcSmartStocktakePreview() {
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return { totalActual: 0, breakdownText: '' };

    const inputs = document.querySelectorAll('.sc-unit-qty-inp');
    let totalActual = 0;
    const formulaParts = [];
    const breakdownParts = [];

    inputs.forEach(inp => {
        const qty = Math.max(0, parseInt(inp.value, 10) || 0);
        const rate = parseInt(inp.getAttribute('data-rate'), 10) || 1;
        const uName = inp.getAttribute('data-unit-name') || item.baseUnit;

        totalActual += qty * rate;
        if (qty > 0) {
            formulaParts.push(rate > 1 ? `(${qty} ${uName} × ${rate})` : `${qty} ${uName}`);
            breakdownParts.push(`${qty} ${uName}`);
        }
    });

    const actualInputHidden = document.getElementById('sc-actual-stock');
    if (actualInputHidden) actualInputHidden.value = totalActual;

    const formulaEl = document.getElementById('sc-formula-preview');
    if (formulaEl) {
        formulaEl.innerText = formulaParts.length > 0 
            ? `${formulaParts.join(' + ')} = ${totalActual} ${item.baseUnit}`
            : `0 ${item.baseUnit}`;
    }

    const diff = totalActual - item.stock;
    const diffBadge = document.getElementById('sc-diff-badge');
    if (diffBadge) {
        if (diff === 0) {
            diffBadge.innerText = `✅ Khớp tồn kho sổ sách (${totalActual} ${item.baseUnit})`;
            diffBadge.className = "font-black text-slate-600";
        } else if (diff > 0) {
            diffBadge.innerText = `📈 DƯ THỪA +${diff} ${item.baseUnit} (Sổ sách: ${item.stock} → Thực tế: ${totalActual} ${item.baseUnit})`;
            diffBadge.className = "font-black text-emerald-600";
        } else {
            diffBadge.innerText = `📉 HAO HỤT ${diff} ${item.baseUnit} (Sổ sách: ${item.stock} → Thực tế: ${totalActual} ${item.baseUnit})`;
            diffBadge.className = "font-black text-red-600";
        }
    }

    return {
        totalActual,
        breakdownText: breakdownParts.length > 0 ? breakdownParts.join(' + ') : `0 ${item.baseUnit}`
    };
}

async function loadStockCardLogs(productId, baseUnit) {
    const tbody = document.getElementById('stock-card-tbody');
    const emptyEl = document.getElementById('sc-empty');
    tbody.innerHTML = `<tr><td colspan="7" class="text-center p-6 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải lịch sử thẻ kho...</td></tr>`;

    try {
        const snap = await db.collection("inventory_logs")
            .where("productId", "==", productId)
            .limit(60)
            .get();

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
            if (log.actionType === 'IMPORT') badge = `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold text-[10px]">NHẬP KHO</span>`;
            else if (log.actionType === 'SALE') badge = `<span class="bg-blue-100 text-inni-blue px-2 py-0.5 rounded font-bold text-[10px]">XUẤT BÁN</span>`;
            else if (log.actionType === 'RETURN') badge = `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-bold text-[10px]">KHÁCH HOÀN</span>`;
            else badge = `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold text-[10px]">CÂN BẰNG KHO</span>`;

            const changeColor = log.changeQty >= 0 ? 'text-emerald-600 font-black' : 'text-red-600 font-black';
            const sign = log.changeQty > 0 ? '+' : '';
            const safeRef = (log.referenceId || '').replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 text-slate-500 whitespace-nowrap">${dStr}</td>
                    <td class="p-2.5">${badge} <span class="font-semibold text-slate-700 ml-1">${log.referenceId || ''}</span></td>
                    <td class="p-2.5 text-slate-600 font-medium">${log.unitDisplay || ''}</td>
                    <td class="p-2.5 text-right font-semibold text-slate-500">${log.startStock}</td>
                    <td class="p-2.5 text-right ${changeColor}">${sign}${log.changeQty} ${baseUnit}</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${log.endStock} ${baseUnit}</td>
                    <td class="p-2.5 text-center whitespace-nowrap">
                        <button onclick="editStockLog('${log.id}', '${safeRef}')" title="Sửa ghi chú dòng này" class="text-amber-600 hover:text-amber-800 px-1.5 py-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteStockLog('${log.id}', ${log.changeQty})" title="Xóa dòng lịch sử này" class="text-red-500 hover:text-red-700 px-1.5 py-1"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center p-4 text-red-500">Lỗi tải thẻ kho: ${e.message}</td></tr>`;
    }
}

async function editStockLog(logId, currentRef) {
    const newRef = prompt("Nhập nội dung / ghi chú mới cho dòng Thẻ kho này:", currentRef);
    if (newRef === null) return;
    await db.collection("inventory_logs").doc(logId).update({ referenceId: newRef.trim() });
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (item) loadStockCardLogs(item.id, item.baseUnit);
}

async function deleteStockLog(logId, changeQty) {
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return;

    if (!confirm(`Bạn muốn xóa dòng lịch sử Thẻ kho này?`)) return;
    const shouldRevertStock = confirm(`Bạn có muốn ĐẢO NGƯỢC số lượng (${changeQty > 0 ? '-' : '+'}${Math.abs(changeQty)} ${item.baseUnit}) vào Tồn kho hiện tại không?\n- OK: Hoàn lại tồn kho.\n- Cancel: Chỉ xóa chữ lịch sử.`);

    if (shouldRevertStock && changeQty !== 0) {
        const newStock = item.stock - changeQty;
        await db.collection("inventory").doc(item.id).update({ stock: newStock });
        document.getElementById('sc-prod-summary').innerText = `Tồn sổ sách hiện tại: ${newStock} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
        renderSmartStocktakeInputs({ ...item, stock: newStock }, false);
    }

    await db.collection("inventory_logs").doc(logId).delete();
    loadStockCardLogs(item.id, item.baseUnit);
}

async function clearAllProductLogs() {
    if (!currentViewingProductId) return;
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!confirm(`Xóa sạch toàn bộ lịch sử Thẻ kho của "${item ? item.name : ''}"?`)) return;

    const snap = await db.collection("inventory_logs").where("productId", "==", currentViewingProductId).get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (item) loadStockCardLogs(item.id, item.baseUnit);
}

function closeStockCardModal() {
    document.getElementById('stock-card-modal').classList.add('hidden');
}

// Chốt Phiếu Cân Bằng Kho từ kết quả đếm Thùng / Lốc / Lon
async function submitStockAdjust() {
    if (!currentViewingProductId) return;
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return;

    const { totalActual, breakdownText } = calcSmartStocktakePreview();
    const userNote = document.getElementById('sc-adjust-note').value.trim();

    if (isNaN(totalActual) || totalActual < 0) return alert("Số lượng đếm thực tế không hợp lệ!");

    const diff = totalActual - item.stock;
    if (diff === 0) return alert(`Số lượng đếm thực tế (${breakdownText} = ${totalActual} ${item.baseUnit}) đang khớp 100% với tồn kho trên máy!`);

    const statusLabel = diff > 0 ? `Dư thừa +${diff} ${item.baseUnit}` : `Hao hụt ${diff} ${item.baseUnit}`;
    const refTitle = userNote ? `${statusLabel} (${userNote})` : `Phiếu Cân Bằng: ${statusLabel}`;
    const unitDisplayStr = `Đếm thực tế: ${breakdownText} (= ${totalActual} ${item.baseUnit})`;

    await db.collection("inventory").doc(item.id).update({ stock: totalActual });
    await writeInventoryLog(item.id, item.name, "ADJUST", refTitle, unitDisplayStr, item.stock, diff, totalActual);
    
    document.getElementById('sc-prod-summary').innerText = `Tồn sổ sách hiện tại: ${totalActual} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
    document.getElementById('sc-adjust-note').value = '';
    loadStockCardLogs(item.id, item.baseUnit);
    alert(`✅ Đã tạo Phiếu Cân Bằng Kho cho "${item.name}"!\n- Đếm thực tế: ${breakdownText} (= ${totalActual} ${item.baseUnit})\n- Chênh lệch: ${statusLabel}`);
}

// ==========================================
// 6. MODULE 1: TẠO PHIẾU NHẬP HÀNG THEO CHUYẾN (NHIỀU MÓN) & CÔNG NỢ ĐẦU VÀO
// ==========================================
function renderPoSupplierSelect(selectedId = null) {
    const sel = document.getElementById('po-supplier-select');
    if (!sel) return;
    const suppliers = (typeof customers !== 'undefined' ? customers : []).filter(c => c.type === 'SUPPLIER');
    sel.innerHTML = `<option value="GENERAL">-- Chọn Nhà Cung Cấp (Hoặc Đại lý lẻ) --</option>`;
    suppliers.forEach(s => {
        const debtTxt = s.currentDebt > 0 ? ` (Đang nợ NPP: ${formatmoney(s.currentDebt)}đ)` : '';
        sel.innerHTML += `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>🚛 ${s.name} - ${s.phone || ''}${debtTxt}</option>`;
    });
}

async function quickAddSupplierFromPo() {
    const name = prompt("Nhập Tên Nhà Cung Cấp mới (VD: Đại lý Bia Cấp 1, NPP Vinamilk...):");
    if (!name || !name.trim()) return;
    const phone = prompt("Số điện thoại Nhà Cung Cấp:") || "";
    const docRef = await db.collection("customers").add({
        type: "SUPPLIER",
        name: name.trim(),
        phone: phone.trim(),
        address: "",
        currentDebt: 0,
        updatedAt: Date.now()
    });
    setTimeout(() => renderPoSupplierSelect(docRef.id), 300);
}

function openPurchaseOrderModal() {
    if (inventory.length === 0) return alert("Kho chưa có mặt hàng nào. Hãy thêm mặt hàng trước!");
    currentPoItems = [];
    renderPoSupplierSelect();
    document.getElementById('po-invoice-no').value = '';
    document.getElementById('po-paid-input').value = '';

    // Xóa trắng ô lọc tìm kiếm mặt hàng mỗi khi mở lại Phiếu Nhập
    if (document.getElementById('po-product-filter')) {
        document.getElementById('po-product-filter').value = '';
    }

    const prodSel = document.getElementById('po-product-id');
    prodSel.innerHTML = inventory.map(i => `<option value="${i.id}">${i.name} (Tồn: ${i.stock} ${i.baseUnit})</option>`).join('');
    onChangePoProduct();
    renderPoItemsTable();
    document.getElementById('po-modal').classList.remove('hidden');
}

function filterPoProductDropdown() {
    const kw = (document.getElementById('po-product-filter')?.value || '').toLowerCase().trim();
    const prodSel = document.getElementById('po-product-id');
    if (!prodSel) return;
    const filtered = inventory.filter(i => 
        !kw || i.name.toLowerCase().includes(kw) || (i.barcode && i.barcode.toLowerCase().includes(kw))
    );
    prodSel.innerHTML = filtered.slice(0, 150).map(i => `<option value="${i.id}">${i.name} (Tồn: ${i.stock} ${i.baseUnit})</option>`).join('');
    onChangePoProduct();
}

function closePurchaseOrderModal() {
    document.getElementById('po-modal').classList.add('hidden');
}

function onChangePoProduct() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    if (!item) return;

    const unitSel = document.getElementById('po-unit-select');
    unitSel.innerHTML = item.units.map((u, idx) => `<option value="${idx}">${u.unitName} (${u.conversionRate} ${item.baseUnit})</option>`).join('');
    if (item.units.length > 1) unitSel.selectedIndex = item.units.length - 1;
    onChangePoUnit();
}

function onChangePoUnit() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    const uIdx = parseInt(document.getElementById('po-unit-select').value, 10) || 0;
    if (!item || !item.units[uIdx]) return;

    const u = item.units[uIdx];
    const suggestedCost = item.costPrice * u.conversionRate;
    document.getElementById('po-import-price').value = formatmoney(suggestedCost);
}

function addPoItemToList() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    const uIdx = parseInt(document.getElementById('po-unit-select').value, 10) || 0;
    const qty = parseInt(document.getElementById('po-qty').value, 10) || 0;
    const importPrice = getRawNum('po-import-price');

    if (!item || qty <= 0 || importPrice <= 0) {
        return alert("Vui lòng nhập số lượng và đơn giá nhập hợp lệ!");
    }

    const u = item.units[uIdx];
    const baseQty = qty * u.conversionRate;
    const totalCost = qty * importPrice;

    currentPoItems.push({
        productId: item.id,
        productName: item.name,
        baseUnit: item.baseUnit,
        unitName: u.unitName,
        conversionRate: u.conversionRate,
        qty,
        baseQty,
        importPrice,
        costPerBaseAtImport: Math.round(importPrice / u.conversionRate),
        totalCost
    });

    document.getElementById('po-qty').value = 1;
    renderPoItemsTable();
}

function removePoItem(idx) {
    currentPoItems.splice(idx, 1);
    renderPoItemsTable();
}

function renderPoItemsTable() {
    const tbody = document.getElementById('po-items-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let grandTotal = 0;
    if (currentPoItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400 italic">Chưa có mặt hàng nào trong phiếu nhập. Hãy chọn mặt hàng ở trên và bấm "Thêm"!</td></tr>`;
    } else {
        currentPoItems.forEach((row, idx) => {
            grandTotal += row.totalCost;
            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 text-center font-bold">${idx + 1}</td>
                    <td class="p-2.5 font-bold text-slate-800">${row.productName}</td>
                    <td class="p-2.5 text-center font-semibold text-inni-blue">${row.unitName}</td>
                    <td class="p-2.5 text-center font-black">${row.qty}</td>
                    <td class="p-2.5 text-center text-emerald-700 font-semibold">+${row.baseQty} ${row.baseUnit}</td>
                    <td class="p-2.5 text-right">${formatmoney(row.importPrice)} đ</td>
                    <td class="p-2.5 text-right font-black text-red-600">${formatmoney(row.totalCost)} đ</td>
                    <td class="p-2.5 text-center">
                        <button onclick="removePoItem(${idx})" class="text-red-500 hover:text-red-700"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    }

    document.getElementById('po-grand-total').innerText = `${formatmoney(grandTotal)} đ`;
    document.getElementById('po-paid-input').value = formatmoney(grandTotal);
    calcPoDebtPreview();
}

function calcPoDebtPreview() {
    const grandTotal = currentPoItems.reduce((s, i) => s + i.totalCost, 0);
    const paid = getRawNum('po-paid-input');
    const remainDebt = Math.max(0, grandTotal - paid);
    document.getElementById('po-debt-preview').innerText = `${formatmoney(remainDebt)} đ`;
}

async function submitPurchaseOrder() {
    if (currentPoItems.length === 0) return alert("Phiếu nhập chưa có mặt hàng nào!");

    const supplierId = document.getElementById('po-supplier-select').value;
    const invoiceNo = document.getElementById('po-invoice-no').value.trim();
    const paidAmount = getRawNum('po-paid-input');
    const payMethod = document.getElementById('po-pay-method').value;
    const grandTotal = currentPoItems.reduce((s, i) => s + i.totalCost, 0);
    const remainDebt = Math.max(0, grandTotal - paidAmount);

    if (remainDebt > 0 && supplierId === 'GENERAL') {
        return alert("Chuyến hàng này còn nợ lại Nhà Cung Cấp! Vui lòng chọn hoặc bấm '+ Thêm NPP Mới' để ghi vào Sổ Nợ Phải Trả.");
    }

    const supObj = (typeof customers !== 'undefined' ? customers : []).find(c => c.id === supplierId);
    const supplierName = supObj ? supObj.name : "Nhà Cung Cấp Lẻ";

    const btn = document.getElementById('btn-submit-po');
    btn.disabled = true;
    btn.innerText = "Đang lưu phiếu nhập...";

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const poCode = `PN-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        await db.collection("purchase_orders").doc(poCode).set({
            poCode,
            invoiceNo: invoiceNo || poCode,
            supplierId,
            supplierName,
            items: currentPoItems,
            totalAmount: grandTotal,
            paidAmount,
            debtAmount: remainDebt,
            paymentMethod: payMethod,
            dateStr,
            createdAt: Date.now()
        });

        for (const pItem of currentPoItems) {
            const dbProd = inventory.find(i => i.id === pItem.productId);
            if (dbProd) {
                const curStock = Math.max(0, dbProd.stock);
                const newMacCost = Math.round(((curStock * dbProd.costPrice) + pItem.totalCost) / (curStock + pItem.baseQty));
                const newStock = dbProd.stock + pItem.baseQty;

                await db.collection("inventory").doc(dbProd.id).update({
                    stock: newStock,
                    costPrice: newMacCost
                });
                await writeInventoryLog(
                    dbProd.id, dbProd.name, "IMPORT", `${poCode} (${supplierName})`,
                    `+${pItem.qty} ${pItem.unitName} (${pItem.baseQty} ${pItem.baseUnit})`,
                    dbProd.stock, pItem.baseQty, newStock
                );
            }
        }

        if (supObj && remainDebt > 0) {
            const oldDebt = Number(supObj.currentDebt) || 0;
            const afterDebt = oldDebt + remainDebt;
            await db.collection("customers").doc(supObj.id).update({ currentDebt: afterDebt, updatedAt: Date.now() });
            await db.collection("debts").add({
                customerId: supObj.id,
                customerName: supObj.name,
                ledgerType: "PAYABLE",
                transactionType: "ORDER_DEBT",
                referenceId: poCode,
                beforeDebt: oldDebt,
                changeAmount: remainDebt,
                afterDebt,
                note: `Nhập chuyến hàng ${poCode}${invoiceNo ? ` (HĐ: ${invoiceNo})` : ''} - Tổng: ${formatmoney(grandTotal)}đ, Đã trả: ${formatmoney(paidAmount)}đ`,
                createdAt: Date.now()
            });
        }

        if (paidAmount > 0) {
            await db.collection("cashbook").add({
                voucherCode: "PC-" + poCode.split('-').pop(),
                type: "EXPENSE",
                channel: payMethod,
                category: "IMPORT",
                amount: paidAmount,
                referenceId: poCode,
                note: `Chi thanh toán phiếu nhập ${poCode} (${supplierName})`,
                seller: document.getElementById('seller-name')?.value || "Chủ Quán",
                dateStr,
                createdAt: Date.now()
            });
        }

        closePurchaseOrderModal();
        alert(`✅ Đã hoàn tất Phiếu Nhập Hàng ${poCode}!\n- Tổng chuyến: ${formatmoney(grandTotal)}đ\n- Đã trả: ${formatmoney(paidAmount)}đ\n- Ghi vào Nợ Phải Trả NPP: ${formatmoney(remainDebt)}đ`);
    } catch (e) {
        alert("Lỗi lưu phiếu nhập: " + e.message);
    }

    btn.disabled = false;
    btn.innerText = "Chốt Phiếu Nhập & Cộng Kho";
}

async function openPoHistoryModal() {
    document.getElementById('po-history-modal').classList.remove('hidden');
    const tbody = document.getElementById('po-history-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải lịch sử nhập hàng...</td></tr>`;

    try {
        const snap = await db.collection("purchase_orders").limit(60).get();
        const pos = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);
        tbody.innerHTML = '';

        if (pos.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 italic">Chưa có lịch sử phiếu nhập hàng nào.</td></tr>`;
            return;
        }

        pos.forEach(po => {
            const dStr = new Date(po.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            const itemsHtml = (po.items || []).map(i => 
                `<div>• <b>${i.productName}</b>: ${i.qty} ${i.unitName} (Giá nhập: ${formatmoney(i.importPrice)}đ/${i.unitName})</div>`
            ).join('');

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5">
                        <div class="font-bold text-emerald-700">${po.poCode}</div>
                        <div class="text-xs text-slate-400">${dStr}</div>
                    </td>
                    <td class="p-2.5">
                        <div class="font-bold text-slate-800">${po.supplierName}</div>
                        <div class="text-xs text-slate-500">Số HĐ: ${po.invoiceNo || '---'}</div>
                    </td>
                    <td class="p-2.5 text-xs text-slate-700 space-y-0.5">${itemsHtml}</td>
                    <td class="p-2.5 text-right font-black text-slate-800">${formatmoney(po.totalAmount)} đ</td>
                    <td class="p-2.5 text-right font-semibold text-emerald-600">${formatmoney(po.paidAmount)} đ</td>
                    <td class="p-2.5 text-right font-bold text-red-600">${formatmoney(po.debtAmount)} đ</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Lỗi: ${e.message}</td></tr>`;
    }
}

function closePoHistoryModal() {
    document.getElementById('po-history-modal').classList.add('hidden');
}

// Hàm phụ trợ làm sạch số tiền từ Excel Sapo (xử lý cả chuỗi "13.500", "13,500" lẫn số nguyên)
function parseExcelNum(val) {
    if (typeof val === 'number') return Math.round(val);
    if (!val) return 0;
    return parseInt(val.toString().replace(/\./g, '').replace(/,/g, '').replace(/\D/g, ''), 10) || 0;
}

// ==========================================
// 7. IMPORT KHO HÀNG HÀNG LOẠT TỪ FILE EXCEL & TẢI FILE MẪU
// ==========================================
function downloadProductSampleExcel() {
    const sampleData = [
        {
            "Tên hàng": "Bia Sài Gòn Lager",
            "Phân loại": "Bia & Rượu",
            "Mã vạch": "893482211234",
            "Đơn vị lẻ": "Lon",
            "Giá nhập": 11500,
            "Giá lẻ": 14000,
            "Giá sỉ": 12500,
            "Đơn vị lốc": "Lốc",
            "Quy đổi lốc": 6,
            "Giá bán lốc": 75000,
            "Đơn vị thùng": "Thùng",
            "Quy đổi thùng": 24,
            "Giá bán thùng": 295000,
            "Số lượng tồn": 1095,
            "Từ khóa Zalo": "sai gon, sg xanh"
        }
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mau_Kho_Hang");
    XLSX.writeFile(wb, "File_Mau_Import_Kho_Hang_Huy_Hoang.xlsx");
}

// Hàm chuẩn hóa tên cột Excel (Bỏ dấu tiếng Việt, bỏ khoảng trắng thừa, đưa về chữ thường để không bao giờ trượt tên cột)
function normalizeExcelColKey(str) {
    if (!str) return '';
    return str.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '');
}

function getExcelColVal(normRow, candidateKeys) {
    for (const k of candidateKeys) {
        const val = normRow[k];
        if (val !== undefined && val !== null && val.toString().trim() !== "") {
            return val;
        }
    }
    return "";
}

async function handleImportProductsExcel(event) {
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
            if (!confirm(`Tìm thấy ${rows.length} dòng sản phẩm từ file Excel. Bạn có muốn nhập / cập nhật hàng loạt vào Kho không?`)) return;

            // Bản đồ tra cứu sản phẩm hiện có (đối chiếu theo Tên Hàng Hóa hoặc Mã Vạch) để Upsert chống trùng lặp
            const workingCatalog = inventory.map(item => ({
                ...item,
                units: Array.isArray(item.units) ? item.units.map(u => ({ ...u })) : []
            }));

            let createdCount = 0;
            let updatedCount = 0;

            for (let i = 0; i < rows.length; i += 350) {
                const chunk = rows.slice(i, i + 350);
                const batch = db.batch();

                chunk.forEach(r => {
                    // Chuẩn hóa toàn bộ tiêu đề cột của dòng hiện tại (chống lỗi chữ HOA/thường & dấu cách thừa)
                    const normRow = {};
                    Object.keys(r).forEach(colName => {
                        const nk = normalizeExcelColKey(colName);
                        if (nk && (normRow[nk] === undefined || normRow[nk] === "")) {
                            normRow[nk] = r[colName];
                        }
                    });

                    const name = getExcelColVal(normRow, [
                        "tenhanghoa", "tenhang", "tensanpham", "tenmathang", "ten", "name", "sanpham"
                    ]).toString().trim();
                    if (!name) return;

                    const category = getExcelColVal(normRow, [
                        "phanloai", "loaisanpham", "nhomhang", "danhmuc", "loai", "category"
                    ]).toString().trim() || "Khác";

                    const barcode = getExcelColVal(normRow, [
                        "mavach", "masku", "sku", "barcode", "mahang", "mahanghoa"
                    ]).toString().trim();

                    const baseUnit = getExcelColVal(normRow, [
                        "donvile", "donvitinh", "donvi", "dvt", "donvicoban", "donvinho", "unit"
                    ]).toString().trim() || "Cái";

                    // 1. Tự động tính Giá vốn kho lõi = Giá Vốn / Tỷ Lệ
                    const rawCost = parseExcelNum(getExcelColVal(normRow, [
                        "giavon", "gianhap", "dongianhap", "giavonthung", "giavonloc", "cost", "costprice"
                    ]));
                    const rawRatio = parseExcelNum(getExcelColVal(normRow, [
                        "tyle", "tile", "heso", "quydoi", "tylequydoi", "slquydoi", "rate"
                    ]));
                    const ratio = rawRatio > 0 ? rawRatio : 1;
                    const calculatedCoreCost = rawCost > 0 ? Math.round(rawCost / ratio) : 0;

                    // 2. Đọc Giá Bán Lẻ & Giá Bán Sỉ (hỗ trợ mọi kiểu đặt tên cột trong Excel)
                    const rawSellPrice = parseExcelNum(getExcelColVal(normRow, [
                        "giaban", "giabanle", "giale", "dongia", "dongiaban", "giabanthung", "gia", "price", "sellingprice"
                    ]));
                    const rawWholesalePrice = parseExcelNum(getExcelColVal(normRow, [
                        "giasi", "giabansi", "dongiasi", "giasile", "wholesaleprice"
                    ]));

                    const rawStockStr = getExcelColVal(normRow, [
                        "soluongton", "tonkho", "ton", "soluong", "slton", "stock"
                    ]);
                    const hasStockCol = rawStockStr !== "";
                    const stock = parseExcelNum(rawStockStr);

                    const kwStr = getExcelColVal(normRow, ["tukhoazalo", "tukhoa", "keywords"]).toString();
                    const keywords = kwStr ? kwStr.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];

                    const packUnit = getExcelColVal(normRow, ["donviloc", "dvloc"]).toString().trim();
                    const packRate = parseExcelNum(getExcelColVal(normRow, ["quydoiloc", "tyleloc"]));
                    const rawPackPrice = parseExcelNum(getExcelColVal(normRow, ["giabanloc", "gialoc"]));

                    const bigUnit = getExcelColVal(normRow, ["donvithung", "dvthung"]).toString().trim();
                    const bigRate = parseExcelNum(getExcelColVal(normRow, ["quydoithung", "tylethung"]));
                    const rawBigPrice = parseExcelNum(getExcelColVal(normRow, ["giabanthung", "giathung"]));

                    // Tìm sản phẩm trùng theo Mã Vạch hoặc Tên Hàng Hóa
                    const normName = name.toLowerCase();
                    const normBc = barcode.toLowerCase();
                    const existingItem = workingCatalog.find(item => {
                        if (normBc && item.barcode && item.barcode.toLowerCase() === normBc) return true;
                        if (normBc && Array.isArray(item.units) && item.units.some(u => u.barcode && u.barcode.toLowerCase() === normBc)) return true;
                        return (item.name || '').trim().toLowerCase() === normName;
                    });

                    if (existingItem) {
                        // ĐÃ CÓ TRONG KHO -> Cập nhật đè Giá Vốn, Giá Bán và ĐVT lên mặt hàng đang có
                        const finalCostPrice = calculatedCoreCost > 0 ? calculatedCoreCost : (existingItem.costPrice || 0);
                        const finalBasePrice = rawSellPrice > 0 ? rawSellPrice : (existingItem.basePrice || 0);
                        const finalWholesalePrice = rawWholesalePrice > 0 ? rawWholesalePrice : (rawSellPrice > 0 ? rawSellPrice : (existingItem.wholesalePrice || finalBasePrice));
                        const finalBaseUnit = baseUnit || existingItem.baseUnit || "Cái";

                        let updatedUnits = Array.isArray(existingItem.units) && existingItem.units.length > 0
                            ? existingItem.units.map(u => ({ ...u }))
                            : [{ unitName: finalBaseUnit, conversionRate: 1, sellingPrice: finalBasePrice, wholesalePrice: finalWholesalePrice, barcode: existingItem.barcode || barcode }];

                        const baseUnitIdx = updatedUnits.findIndex(u => Number(u.conversionRate) === 1);
                        if (baseUnitIdx !== -1) {
                            updatedUnits[baseUnitIdx].unitName = finalBaseUnit;
                            updatedUnits[baseUnitIdx].sellingPrice = finalBasePrice;
                            updatedUnits[baseUnitIdx].wholesalePrice = finalWholesalePrice;
                            if (barcode) updatedUnits[baseUnitIdx].barcode = barcode;
                        }

                        const packPrice = rawPackPrice || (packRate > 1 ? finalWholesalePrice * packRate : 0);
                        if (packUnit && packRate > 1 && packPrice > 0) {
                            const pIdx = updatedUnits.findIndex(u => u.unitName.toLowerCase() === packUnit.toLowerCase() || Number(u.conversionRate) === packRate);
                            if (pIdx !== -1) {
                                updatedUnits[pIdx] = { ...updatedUnits[pIdx], unitName: packUnit, conversionRate: packRate, sellingPrice: packPrice, wholesalePrice: packPrice };
                            } else {
                                updatedUnits.push({ unitName: packUnit, conversionRate: packRate, sellingPrice: packPrice, wholesalePrice: packPrice, barcode: "" });
                            }
                        }

                        const bigPrice = rawBigPrice || (bigRate > 1 ? finalWholesalePrice * bigRate : 0);
                        if (bigUnit && bigRate > 1 && bigPrice > 0) {
                            const bIdx = updatedUnits.findIndex(u => u.unitName.toLowerCase() === bigUnit.toLowerCase() || Number(u.conversionRate) === bigRate);
                            if (bIdx !== -1) {
                                updatedUnits[bIdx] = { ...updatedUnits[bIdx], unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigPrice, wholesalePrice: bigPrice };
                            } else {
                                updatedUnits.push({ unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigPrice, wholesalePrice: bigPrice, barcode: "" });
                            }
                        }

                        const updatePayload = {
                            baseUnit: finalBaseUnit,
                            costPrice: finalCostPrice,
                            basePrice: finalBasePrice,
                            wholesalePrice: finalWholesalePrice,
                            price: finalBasePrice,
                            units: updatedUnits
                        };
                        if (barcode) updatePayload.barcode = barcode;
                        if (hasStockCol) updatePayload.stock = stock;

                        const docRef = db.collection("inventory").doc(existingItem.id);
                        batch.update(docRef, updatePayload);

                        Object.assign(existingItem, updatePayload);
                        updatedCount++;
                    } else {
                        // CHƯA CÓ TRONG KHO -> Tạo sản phẩm mới hoàn toàn
                        const finalBasePrice = rawSellPrice;
                        const finalWholesalePrice = rawWholesalePrice || finalBasePrice;
                        const finalCostPrice = calculatedCoreCost > 0 ? calculatedCoreCost : Math.round(finalBasePrice * 0.85);

                        const units = [{ unitName: baseUnit, conversionRate: 1, sellingPrice: finalBasePrice, wholesalePrice: finalWholesalePrice, barcode }];

                        const packPrice = rawPackPrice || (finalWholesalePrice * packRate);
                        if (packUnit && packRate > 1 && packPrice > 0) {
                            units.push({ unitName: packUnit, conversionRate: packRate, sellingPrice: packPrice, wholesalePrice: packPrice, barcode: "" });
                        }

                        const bigPrice = rawBigPrice || (finalWholesalePrice * bigRate);
                        if (bigUnit && bigRate > 1 && bigPrice > 0) {
                            units.push({ unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigPrice, wholesalePrice: bigPrice, barcode: "" });
                        }

                        const docRef = db.collection("inventory").doc();
                        const newProdObj = {
                            name, category, barcode, keywords, baseUnit,
                            costPrice: finalCostPrice,
                            basePrice: finalBasePrice,
                            wholesalePrice: finalWholesalePrice,
                            price: finalBasePrice,
                            stock, minStock: 24, units,
                            createdAt: Date.now() + createdCount
                        };
                        batch.set(docRef, newProdObj);
                        workingCatalog.push({ id: docRef.id, ...newProdObj });
                        createdCount++;
                    }
                });

                await batch.commit();
            }

            event.target.value = '';
            alert(`✅ Hoàn tất Import Excel vào Kho!\n- Tạo mới: ${createdCount} mặt hàng\n- Cập nhật đè giá (Upsert): ${updatedCount} mặt hàng`);
        } catch (err) {
            alert("Lỗi đọc file Excel: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function applyStoreSettingsToUI() {
    const sName = storeSettings.storeName || "Đại Lý HỒNG ĐIỆP";
    ['sidebar-store-name', 'mobile-home-store-name', 'more-store-name'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = sName;
    });
    const billNameEl = document.getElementById('bill-store-name');
    if (billNameEl) billNameEl.innerText = sName.toUpperCase();
    const billPhoneEl = document.getElementById('bill-store-phone');
    if (billPhoneEl) billPhoneEl.innerText = storeSettings.phone || "---";
    const billAddrEl = document.getElementById('bill-store-address');
    if (billAddrEl) billAddrEl.innerText = storeSettings.address || "";

    document.body.classList.remove('print-mode-A5', 'print-mode-80mm');
    document.body.classList.add('print-mode-' + (storeSettings.printSize || 'A5'));
}

function openSettingsModal() {
    document.getElementById('set-store-name').value = storeSettings.storeName || "";
    document.getElementById('set-store-phone').value = storeSettings.phone || "";
    document.getElementById('set-store-address').value = storeSettings.address || "";
    document.getElementById('set-print-size').value = storeSettings.printSize || 'A5';
    document.getElementById('set-bank-id').value = storeSettings.bankId || 'MB';
    document.getElementById('set-bank-acc').value = storeSettings.bankAcc || '';
    document.getElementById('set-bank-owner').value = storeSettings.bankOwner || '';
    document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.add('hidden');
}

async function saveStoreSettings() {
    const newSettings = {
        storeName: document.getElementById('set-store-name').value.trim() || " Đại Lý HỒNG ĐIỆP",
        phone: document.getElementById('set-store-phone').value.trim(),
        address: document.getElementById('set-store-address').value.trim(),
        printSize: document.getElementById('set-print-size').value || "A5",
        bankId: document.getElementById('set-bank-id').value || "MB",
        bankAcc: document.getElementById('set-bank-acc').value.trim(),
        bankOwner: document.getElementById('set-bank-owner').value.trim().toUpperCase(),
        updatedAt: Date.now()
    };
    storeSettings = { ...storeSettings, ...newSettings };
    localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
    applyStoreSettingsToUI();

    try {
        await db.collection("shop_data").doc("settings").set(storeSettings, { merge: true });
        closeSettingsModal();
        alert("✅ Đã lưu bền vững cấu hình Cửa hàng & VietQR lên hệ thống!");
    } catch (e) {
        closeSettingsModal();
        alert("⚠️ Đã lưu cấu hình trên thiết bị này, nhưng chưa đồng bộ được Cloud: " + e.message);
    }
}

// ==========================================
// MÀN HÌNH ĐỘC LẬP TRONG MENU SẢN PHẨM: ĐƠN NHẬP HÀNG, NHÀ CUNG CẤP, KIỂM HÀNG (MODULE 6.3)
// ==========================================
let cachedPurchaseOrders = [];
let poScreenLimit = 40;

async function openPoListScreen() {
    document.getElementById('po-list-screen-modal').classList.remove('hidden');
    const listEl = document.getElementById('po-screen-flat-list');
    listEl.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Đang tải danh sách đơn nhập hàng...</div>`;

    try {
        const snap = await db.collection("purchase_orders").limit(100).get();
        cachedPurchaseOrders = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        renderPoListScreen(true);
    } catch (e) {
        listEl.innerHTML = `<div class="p-6 text-center text-red-500 text-xs">Lỗi tải phiếu nhập: ${e.message}</div>`;
    }
}

function closePoListScreen() {
    document.getElementById('po-list-screen-modal').classList.add('hidden');
}

function renderPoListScreen(reset = false) {
    if (reset) poScreenLimit = 40;
    const listEl = document.getElementById('po-screen-flat-list');
    const kw = (document.getElementById('po-screen-search')?.value || '').toLowerCase().trim();
    if (!listEl) return;

    const filtered = cachedPurchaseOrders.filter(po => {
        if (!kw) return true;
        return (po.poCode || '').toLowerCase().includes(kw) || (po.supplierName || '').toLowerCase().includes(kw);
    });

    document.getElementById('po-screen-count').innerText = `${filtered.length} phiếu nhập`;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="p-10 text-center text-slate-400 italic text-xs">Chưa có đơn nhập hàng nào khớp.</div>`;
        return;
    }

    listEl.innerHTML = filtered.slice(0, poScreenLimit).map(po => {
        const dStr = new Date(po.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const hasDebt = (Number(po.debtAmount) || 0) > 0;
        const statusBadge = hasDebt
            ? `<span class="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">Chưa thanh toán (${formatmoney(po.debtAmount)}đ)</span>`
            : `<span class="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Hoàn thành</span>`;

        return `
            <div class="p-3.5 flex justify-between items-center active:bg-slate-50">
                <div class="space-y-0.5">
                    <div class="font-bold text-slate-800 text-sm">${po.poCode}</div>
                    <div class="text-xs text-slate-600 font-medium">${po.supplierName || 'Nhà cung cấp lẻ'}</div>
                    <div class="text-[11px] text-slate-400">${dStr}</div>
                </div>
                <div class="text-right space-y-1">
                    <div class="font-bold text-slate-800 text-sm">${formatmoney(po.totalAmount)} đ</div>
                    <div>${statusBadge}</div>
                </div>
            </div>
        `;
    }).join('');
}

function openSuppliersScreen() {
    document.getElementById('suppliers-screen-modal').classList.remove('hidden');
    renderSuppliersScreen();
}

function closeSuppliersScreen() {
    document.getElementById('suppliers-screen-modal').classList.add('hidden');
}

function openSupplierCreateModal() {
    openCustomerModal(null);
    const typeSel = document.getElementById('cust-type');
    if (typeSel) typeSel.value = 'SUPPLIER';
}

function renderSuppliersScreen() {
    const listEl = document.getElementById('sup-screen-flat-list');
    const kw = (document.getElementById('sup-screen-search')?.value || '').toLowerCase().trim();
    if (!listEl) return;

    const suppliersOnly = (typeof customers !== 'undefined' ? customers : []).filter(c => c.type === 'SUPPLIER');
    const filtered = suppliersOnly.filter(s => {
        if (!kw) return true;
        return (s.name || '').toLowerCase().includes(kw) || (s.phone || '').includes(kw) || (s.address || '').toLowerCase().includes(kw);
    });

    document.getElementById('sup-screen-count').innerText = `${filtered.length} nhà cung cấp`;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="p-10 text-center text-slate-400 italic text-xs">Chưa có nhà cung cấp nào. Bấm nút (+) để thêm mới.</div>`;
        return;
    }

    listEl.innerHTML = filtered.map(s => {
        const debt = Number(s.currentDebt) || 0;
        return `
            <div onclick="openDebtLedgerModal('${s.id}')" class="p-3.5 flex justify-between items-center active:bg-slate-50 cursor-pointer">
                <div class="space-y-0.5 min-w-0 flex-1 pr-2">
                    <div class="font-bold text-slate-800 text-sm truncate">${s.name}</div>
                    <div class="text-xs text-slate-500">${s.phone || 'Chưa có SĐT'}</div>
                    <div class="text-[11px] text-slate-400 truncate">${s.address || 'Chưa cập nhật địa chỉ'}</div>
                </div>
                <div class="text-right shrink-0 space-y-1">
                    <div class="text-[11px] text-slate-400">Nợ cần trả</div>
                    <div class="font-bold text-sm ${debt > 0 ? 'text-red-600' : 'text-emerald-600'}">${formatmoney(debt)} đ</div>
                </div>
            </div>
        `;
    }).join('');
}

function openMobileStocktakeScreen() {
    if (inventory.length === 0) return alert("Kho chưa có sản phẩm nào!");
    document.getElementById('st-mob-filter').value = '';
    document.getElementById('st-mob-note').value = '';
    filterMobileStocktakeProducts();
    document.getElementById('stocktake-screen-modal').classList.remove('hidden');
}

function closeMobileStocktakeScreen() {
    document.getElementById('stocktake-screen-modal').classList.add('hidden');
}

function filterMobileStocktakeProducts() {
    const kw = (document.getElementById('st-mob-filter')?.value || '').toLowerCase().trim();
    const sel = document.getElementById('st-mob-prod-select');
    if (!sel) return;
    const matched = inventory.filter(i => !kw || i.name.toLowerCase().includes(kw) || (i.barcode && i.barcode.toLowerCase().includes(kw))).slice(0, 100);
    sel.innerHTML = matched.map(i => `<option value="${i.id}">${i.name} (Tồn: ${i.stock} ${i.baseUnit})</option>`).join('');
    onSelectMobileStocktakeProduct(false);
}

function onSelectMobileStocktakeProduct(resetZero = false) {
    const prodId = document.getElementById('st-mob-prod-select')?.value;
    const item = inventory.find(i => i.id === prodId);
    const wrap = document.getElementById('st-mob-unit-inputs');
    if (!item || !wrap) return;

    document.getElementById('st-mob-system-stock').innerText = `${item.stock} ${item.baseUnit}`;
    const breakdown = breakdownStockByUnits(resetZero ? 0 : item.stock, item.units);

    wrap.innerHTML = breakdown.map(b => `
        <div class="bg-[#F4F6F8] p-2.5 rounded-xl border border-slate-200">
            <label class="block text-[11px] font-bold text-slate-700 mb-1">${b.unitName} (×${b.conversionRate} ${item.baseUnit})</label>
            <input type="number" min="0" value="${resetZero ? '' : b.count}" placeholder="0"
                data-unit-name="${b.unitName}" data-rate="${b.conversionRate}"
                oninput="calcMobileStocktakeDiff()"
                class="st-mob-qty-inp w-full bg-white border border-slate-300 rounded-lg p-2 text-center font-black text-sm text-[#0088FF]">
        </div>
    `).join('');

    calcMobileStocktakeDiff();
}

function calcMobileStocktakeDiff() {
    const prodId = document.getElementById('st-mob-prod-select')?.value;
    const item = inventory.find(i => i.id === prodId);
    if (!item) return { totalActual: 0, diff: 0, breakdownStr: '' };

    let totalActual = 0;
    const parts = [];
    document.querySelectorAll('.st-mob-qty-inp').forEach(inp => {
        const q = Math.max(0, parseInt(inp.value, 10) || 0);
        const r = parseInt(inp.getAttribute('data-rate'), 10) || 1;
        const u = inp.getAttribute('data-unit-name') || item.baseUnit;
        totalActual += q * r;
        if (q > 0) parts.push(`${q} ${u}`);
    });

    const diff = totalActual - item.stock;
    const breakdownStr = parts.length > 0 ? parts.join(' + ') : `0 ${item.baseUnit}`;
    document.getElementById('st-mob-actual-total').innerText = `${totalActual} ${item.baseUnit} (${breakdownStr})`;

    const diffEl = document.getElementById('st-mob-diff-text');
    if (diff === 0) {
        diffEl.innerText = "Khớp tồn hệ thống (0)";
        diffEl.className = "font-bold text-slate-600";
    } else if (diff > 0) {
        diffEl.innerText = `Dư thừa +${diff} ${item.baseUnit}`;
        diffEl.className = "font-bold text-emerald-600";
    } else {
        diffEl.innerText = `Hao hụt ${diff} ${item.baseUnit}`;
        diffEl.className = "font-bold text-red-600";
    }
    return { totalActual, diff, breakdownStr };
}

async function confirmMobileStocktakeAdjust() {
    const prodId = document.getElementById('st-mob-prod-select')?.value;
    const item = inventory.find(i => i.id === prodId);
    if (!item) return;

    const { totalActual, diff, breakdownStr } = calcMobileStocktakeDiff();
    if (diff === 0) return alert("Số lượng kiểm thực tế đang khớp 100% với hệ thống!");

    const note = document.getElementById('st-mob-note')?.value.trim() || "Kiểm hàng trên Mobile";
    const diffLabel = diff > 0 ? `+${diff} ${item.baseUnit}` : `${diff} ${item.baseUnit}`;

    if (!confirm(`XÁC NHẬN CÂN BẰNG KHO:\n- Sản phẩm: ${item.name}\n- Tồn hệ thống cũ: ${item.stock} ${item.baseUnit}\n- Đếm thực tế: ${breakdownStr} (= ${totalActual} ${item.baseUnit})\n- Chênh lệch: ${diffLabel}\n\nBạn có chắc chắn muốn lưu điều chỉnh tồn kho không?`)) {
        return;
    }

    try {
        await db.collection("inventory").doc(item.id).update({ stock: totalActual });
        await writeInventoryLog(item.id, item.name, "ADJUST", `KIỂM-KHO (${note})`, `Thực đếm: ${breakdownStr}`, item.stock, diff, totalActual);
        alert(`✅ Đã lưu phiếu kiểm kho và cập nhật tồn mới: ${totalActual} ${item.baseUnit}`);
        onSelectMobileStocktakeProduct(false);
    } catch (e) {
        alert("Lỗi khi lưu kiểm kho: " + e.message);
    }
}

// Debounce & Infinite Scroll tự động cho danh sách Sản phẩm khi cuộn gần đáy
let invSearchTimer = null;
function initInventoryInfiniteScroll() {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;
    mainEl.addEventListener('scroll', () => {
        if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 180) {
            const invTab = document.getElementById('tab-inventory');
            if (invTab && !invTab.classList.contains('hidden')) {
                const moreWrap = document.getElementById('inv-load-more-wrap');
                if (moreWrap && !moreWrap.classList.contains('hidden')) {
                    loadMoreInventory();
                }
            }
            const ordTab = document.getElementById('tab-orders');
            if (ordTab && !ordTab.classList.contains('hidden') && typeof loadMoreOrders === 'function') {
                const ordMore = document.getElementById('ord-load-more-wrap');
                if (ordMore && !ordMore.classList.contains('hidden')) {
                    loadMoreOrders();
                }
            }
        }
    }, { passive: true });

    const invSearchInp = document.getElementById('inv-search-name');
    if (invSearchInp) {
        invSearchInp.removeAttribute('oninput');
        invSearchInp.addEventListener('input', () => {
            clearTimeout(invSearchTimer);
            invSearchTimer = setTimeout(() => renderInventory(true), 250);
        });
    }
}

// ==========================================
// 9. BẢO MẬT MÃ PIN & SAO LƯU TOÀN BỘ DỮ LIỆU (FULL BACKUP)
// ==========================================
const SHOP_PIN_CODE = localStorage.getItem('hh_shop_pin') || "1234";

window.addEventListener('DOMContentLoaded', () => {
    const isAuth = localStorage.getItem('hh_auth_remember') === 'true' || sessionStorage.getItem('hh_auth_session') === 'true';
    if (!isAuth) {
        document.getElementById('auth-lock-modal')?.classList.remove('hidden');
    }
});

function verifyShopPin() {
    const inp = document.getElementById('auth-pin-input')?.value.trim();
    const remember = document.getElementById('auth-remember-chk')?.checked;
    if (inp === SHOP_PIN_CODE) {
        sessionStorage.setItem('hh_auth_session', 'true');
        if (remember) localStorage.setItem('hh_auth_remember', 'true');
        document.getElementById('auth-lock-modal')?.classList.add('hidden');
    } else {
        alert("Mã PIN không chính xác!");
    }
}

async function exportFullBackupData() {
    try {
        const [invSnap, custSnap, ordSnap, debtSnap, cbSnap] = await Promise.all([
            db.collection("inventory").get(),
            db.collection("customers").get(),
            db.collection("orders").orderBy("createdAt", "desc").limit(2000).get(),
            db.collection("debts").orderBy("createdAt", "desc").limit(2000).get(),
            db.collection("cashbook").orderBy("createdAt", "desc").limit(2000).get()
        ]);

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invSnap.docs.map(d => d.data())), "Kho_Hang");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(custSnap.docs.map(d => d.data())), "Khach_Hang_Cong_No");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ordSnap.docs.map(d => {
            const o = d.data();
            return { ...o, items: JSON.stringify(o.items || []), customerSnapshot: JSON.stringify(o.customerSnapshot || {}) };
        })), "Hoa_Don");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(debtSnap.docs.map(d => d.data())), "Lich_Su_So_No");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cbSnap.docs.map(d => d.data())), "So_Quy");

        const dateStr = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `Full_Backup_Huy_Hoang_${dateStr}.xlsx`);
    } catch (e) {
        alert("Lỗi khi tải bản sao lưu: " + e.message);
    }
}