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

// Cấu hình ưu tiên đồng bộ mạng chuẩn xác, tránh kẹt giá cũ trong IndexedDB khi thoát ra vào lại
db.settings({
    cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED,
    merge: true
});

const CATEGORIES = [
    // 1. Đồ uống & Giải khát
    "Nước giải khát & Nước lọc",
    "Bia, Rượu & Đồ uống có cồn",
    "Trà, Cà phê & Đồ uống hòa tan",
    "Sữa & Chế phẩm từ sữa",
    
    // 2. Thực phẩm khô, Gia vị & Đồ ăn liền
    "Mì, Phở, Cháo & Đồ ăn liền",
    "Gia vị, Dầu ăn, Nước chấm & Bột nấu ăn", // <-- Bột chiên giòn, bột chiên xù, bột ngọt, hạt nêm vào đây
    "Gạo, Bột các loại, Đồ khô & Ngũ cốc",   // <-- Bột mì, bột năng, đậu, bún/miến khô, nấm mèo vào đây
    "Đồ hộp, Xúc xích & Thực phẩm chế biến",  // <-- MỚI: Cá hộp, thịt hộp, xúc xích, lạp xưởng
    "Bánh kẹo, Snack, Bim bim & Hạt",
    
    // 3. Hóa mỹ phẩm, Giấy & Chăm sóc cá nhân
    "Xà bông, Bột giặt & Nước giặt xả",
    "Nước rửa chén, Lau sàn & Vệ sinh nhà cửa",
    "Chăm sóc cá nhân (Dầu gội, Sữa tắm, Kem đánh răng)",
    "Bỉm tã, Băng vệ sinh & Chăm sóc em bé",  // <-- MỚI: Tã em bé, BVS, khăn ướt
    "Giấy vệ sinh, Khăn giấy & Đồ dùng một lần", // <-- Ly nhựa, ống hút, hộp xốp, bọc xốp
    
    // 4. Các mặt hàng đại lý khác
    "Kem, Đá viên & Đồ đông lạnh",
    "Thuốc lá, Hộp quẹt & Phụ kiện",
    "Đồ dùng gia đình, Pin, Bóng đèn & Tiện ích", // <-- Dao cạo râu, keo 502, nhang muỗi, bật lửa
    "Khác"
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

    if (tabId === 'tab-inventory') renderInventory(false);
}

// ==========================================
// 3. LẮNG NGHE DỮ LIỆU KHO HÀNG (ĐỒNG BỘ TRỰC TIẾP TỪ SERVER, LUÔN LẤY GIÁ MỚI NHẤT)
// ==========================================
function mapInventoryDoc(doc) {
    const d = doc.data();
    const baseUnit = (d.baseUnit || "Cái").trim();
    const basePrice = Number(d.basePrice ?? d.price ?? 0);
    const wholesalePrice = Number(d.wholesalePrice ?? basePrice);
    const costPrice = d.costPrice !== undefined && d.costPrice !== null && d.costPrice !== ""
        ? Number(d.costPrice)
        : Math.round(basePrice * 0.85);

    let rawUnits = Array.isArray(d.units) && d.units.length > 0 ? d.units.map(u => ({ ...u })) : [];
    const baseUnitObj = {
        unitName: baseUnit,
        conversionRate: 1,
        sellingPrice: basePrice,
        wholesalePrice: wholesalePrice,
        barcode: d.barcode || ""
    };

    // Giữ đúng 1 đơn vị gốc ở đầu và lấy giá mới nhất cho các đơn vị quy đổi (Lốc/Thùng)
    const extraUnitsMap = new Map();
    rawUnits.forEach((u, idx) => {
        const uName = (u.unitName || "").trim();
        const rate = Number(u.conversionRate) || 1;
        if (!uName) return;
        if (rate === 1 && (idx === 0 || uName.toLowerCase() === baseUnit.toLowerCase())) return;
        extraUnitsMap.set(uName.toLowerCase(), {
            unitName: uName,
            conversionRate: rate,
            sellingPrice: Number(u.sellingPrice ?? u.wholesalePrice ?? 0),
            wholesalePrice: Number(u.wholesalePrice ?? u.sellingPrice ?? 0),
            barcode: u.barcode || ""
        });
    });

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
        costPrice: costPrice,
        stock: Number(d.stock ?? 0),
        minStock: Number(d.minStock ?? 10),
        units: [baseUnitObj, ...Array.from(extraUnitsMap.values())],
        createdAt: d.createdAt || 0,
        updatedAt: d.updatedAt || d.createdAt || 0
    };
}

// Ép lấy dữ liệu mới nhất trực tiếp từ Cloud Server khi mở App
db.collection("inventory").get({ source: 'server' }).then((serverSnap) => {
    inventory = serverSnap.docs.map(mapInventoryDoc);
    inventory.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    renderInventory(false);
    if (typeof renderSellGrid === 'function') renderSellGrid();
}).catch(() => {});

db.collection("inventory").onSnapshot((snapshot) => {
    inventory = snapshot.docs.map(mapInventoryDoc);
    inventory.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    renderInventory(false);
    if (typeof renderSellGrid === 'function') renderSellGrid();
});

// ==========================================
// 4. HIỂN THỊ KHO HÀNG & ĐA ĐƠN VỊ TÍNH
// ==========================================
function breakdownStockByUnits(totalBaseStock, units) {
    let remaining = Math.max(0, totalBaseStock);
    const sortedUnits = [...units].filter(u => Number(u.conversionRate) > 0).sort((a, b) => b.conversionRate - a.conversionRate);
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
    // Nếu resetLimit = true (ví dụ khi gọi lại hàm do gõ tìm kiếm hoặc load dữ liệu mới) -> Đặt lại giới hạn số lượng render
    if (resetLimit) invRenderLimit = 40;
    
    const tbody = document.getElementById('inventory-list');
    const mobList = document.getElementById('inventory-mobile-list');
    const noRes = document.getElementById('inv-no-result');
    if (!tbody) return;
    
    // TRÁNH RESET GIAO DIỆN NẾU ĐANG SCROLL VÀ Ô TÌM KIẾM CÓ CHỮ
    const searchInp = document.getElementById('inv-search-name');
    const search = (searchInp?.value || '').toLowerCase().trim();
    const catFilter = document.getElementById('inv-search-cat')?.value || 'all';
    const stockFilter = document.getElementById('inv-filter-stock')?.value || 'all';

    // Chỉ làm trống bảng nếu gọi reset hoặc bảng chưa được render đủ
    if (resetLimit) {
        tbody.innerHTML = '';
        if (mobList) mobList.innerHTML = '';
    } else {
        // Nếu không reset, kiểm tra xem bảng đã có dữ liệu chưa. Nếu có rồi thì bỏ qua không render lại từ đầu, chống mất danh sách tìm kiếm khi chuyển tab
        if (tbody.children.length > 0 && search !== '') return;
        tbody.innerHTML = '';
        if (mobList) mobList.innerHTML = '';
    }

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

        const wholesaleUnits = item.units.filter((u, idx) => idx > 0 || Number(u.conversionRate) > 1);
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
        ? `<span class="px-1.5 py-0.5 bg-red-50 text-red-600 border border-red-200 text-[10px] font-bold rounded">
            <i class="fa-solid fa-triangle-exclamation mr-0.5"></i>Sắp hết (≤${item.minStock})
        </span>` 
        : '';

        const tr = document.createElement('tr');
        tr.className = `transition ${rowBg}`;
        tr.innerHTML = `
            <td class="p-3">${imgTag}</td>
            <td class="p-3">
                <div class="font-bold text-slate-800">${item.name}</div>
                <div class="text-[11px] text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
                    <span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-semibold">${item.category}</span>
                    ${lowBadge}
                    ${item.barcode ? `<span><i class="fa-solid fa-barcode"></i> ${item.barcode}</span>` : ''}
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

        // 2. Dữ liệu Thẻ Sản Phẩm trên Mobile
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

            const extraUnitsMob = wholesaleUnits.map(u =>
                `<span class="inline-block bg-blue-50 text-[#0088FF] border border-blue-200 px-1.5 py-0.2 rounded text-[10px] font-bold mt-0.5 mr-1">${u.unitName}: ${formatmoney(u.sellingPrice)}</span>`
            ).join('');

            mobList.innerHTML += `
                <div class="flex items-center justify-between px-3.5 py-3 gap-2.5 active:bg-slate-50" onclick="openProductModal('${item.id}')">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        ${mobThumb}
                        <div class="min-w-0 flex-1">
                            <div class="font-bold text-slate-800 text-[13px] truncate">${item.name}</div>
                            <div class="text-[11px] text-slate-400 truncate mt-0.5">${item.barcode || 'Chưa có SKU'}</div>
                            ${extraUnitsMob ? `<div>${extraUnitsMob}</div>` : ''}
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

    const lowMobEl = document.getElementById('inv-stat-low-mob');
    if (lowMobEl) lowMobEl.innerText = `${lowStockCount} món`;

    const mobCntEl = document.getElementById('inv-mobile-count-label');
    if (mobCntEl) mobCntEl.innerText = `${renderedCount} sản phẩm`;
    const loadMoreWrap = document.getElementById('inv-load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.classList.toggle('hidden', renderedCount <= invRenderLimit);

    const badgeDesk = document.getElementById('badge-low-stock');
    const badgeMob = document.getElementById('badge-mobile-low-stock');
    if (lowStockCount > 0) {
        if (badgeDesk) { badgeDesk.innerText = lowStockCount; badgeDesk.classList.remove('hidden'); }
        if (badgeMob) {
            badgeMob.innerText = lowStockCount;
            badgeMob.className = "absolute -top-1 right-2 bg-red-600 text-white text-[9px] font-black px-1.5 rounded-full";
        }
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

        const wholesaleUnits = item.units.filter((u, idx) => idx > 0 || Number(u.conversionRate) > 1);
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
    const id = document.getElementById('prod-id').value.trim();
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value;
    const keywordsRaw = document.getElementById('prod-keywords').value;
    const barcode = document.getElementById('prod-barcode').value.trim();
    const baseUnit = document.getElementById('prod-base-unit').value.trim() || 'Cái';
    
    const costInputRaw = document.getElementById('prod-cost-price')?.value.trim() || '';
    const costPrice = getRawNum('prod-cost-price');
    const basePrice = getRawNum('prod-base-price');
    const wholesaleInputRaw = document.getElementById('prod-wholesale-price')?.value.trim() || '';
    const wholesalePrice = wholesaleInputRaw !== '' ? getRawNum('prod-wholesale-price') : basePrice;
    
    const stock = parseInt(document.getElementById('prod-stock').value, 10) || 0;
    const minStock = parseInt(document.getElementById('prod-min-stock').value, 10) || 0;
    const imageInput = document.getElementById('prod-image');

    if (!name || basePrice <= 0) {
        return alert("Vui lòng nhập Tên sản phẩm và Giá bán lẻ hợp lệ!");
    }

    const keywords = keywordsRaw.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    
    const units = [{
        unitName: baseUnit,
        conversionRate: 1,
        sellingPrice: basePrice,
        wholesalePrice: wholesalePrice,
        barcode: barcode
    }];

    document.querySelectorAll('#unit-rows-container .unit-row').forEach(row => {
        const uName = row.querySelector('.unit-name').value.trim();
        const uRate = parseInt(row.querySelector('.unit-rate').value, 10) || 0;
        const uRetailPrice = getRawNum(row.querySelector('.unit-price'));
        const uWholesalePrice = getRawNum(row.querySelector('.unit-wholesale-price'));
        const uBarcode = row.querySelector('.unit-barcode').value.trim();

        if (uName && (uRetailPrice > 0 || uWholesalePrice > 0)) {
            const finalRate = uRate > 1 ? uRate : 1;
            const finalRetail = uRetailPrice > 0 ? uRetailPrice : uWholesalePrice;
            const finalWholesale = uWholesalePrice > 0 ? uWholesalePrice : uRetailPrice;

            if (finalRate === 1 && uName.toLowerCase() === baseUnit.toLowerCase()) {
                units[0].sellingPrice = finalRetail;
                units[0].wholesalePrice = finalWholesale;
                if (uBarcode) units[0].barcode = uBarcode;
            } else {
                const existUIdx = units.findIndex((u, idx) => idx > 0 && u.unitName.toLowerCase() === uName.toLowerCase());
                const unitObj = {
                    unitName: uName,
                    conversionRate: finalRate,
                    sellingPrice: finalRetail,
                    wholesalePrice: finalWholesale,
                    barcode: uBarcode
                };
                if (existUIdx !== -1) units[existUIdx] = unitObj;
                else units.push(unitObj);
            }
        }
    });

    const btn = document.getElementById('btn-save-product');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;

    const finalCostPrice = costInputRaw !== '' ? costPrice : Math.round(basePrice * 0.85);
    const nowTs = Date.now();

    const productData = {
        name,
        category,
        keywords,
        barcode,
        baseUnit,
        costPrice: finalCostPrice,
        basePrice: basePrice,
        wholesalePrice: wholesalePrice,
        price: basePrice,
        stock,
        minStock,
        units,
        updatedAt: nowTs
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
        const normTargetName = name.toLowerCase().replace(/\s+/g, ' ');

        if (!id) {
            productData.createdAt = nowTs;
            const docRef = await db.collection("inventory").add(productData);
            const newItemObj = { id: docRef.id, ...productData };
            const existIdx = inventory.findIndex(i => i.id === docRef.id);
            if (existIdx !== -1) inventory[existIdx] = newItemObj;
            else inventory.unshift(newItemObj);

            if (stock > 0) {
                await writeInventoryLog(docRef.id, name, "IMPORT", "KHỞI-TẠO", `${stock} ${baseUnit}`, 0, stock, stock);
            }
        } else {
            const oldIdx = inventory.findIndex(i => i.id === id);
            const oldItem = oldIdx !== -1 ? inventory[oldIdx] : null;

            await db.collection("inventory").doc(id).set(productData, { merge: true });

            if (oldIdx !== -1) {
                inventory[oldIdx] = {
                    ...inventory[oldIdx],
                    ...productData,
                    id: id,
                    image: productData.image !== undefined ? productData.image : inventory[oldIdx].image
                };
            }

            // Tự động cập nhật ngầm giá mới nhất lên Cloud cho mọi bản ghi cùng tên (nếu có)
            const sameNameItems = inventory.filter(i => i.id !== id && (i.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === normTargetName);
            for (const sameItem of sameNameItems) {
                const syncPricePayload = {
                    baseUnit: baseUnit,
                    costPrice: finalCostPrice,
                    basePrice: basePrice,
                    wholesalePrice: wholesalePrice,
                    price: basePrice,
                    units: units,
                    updatedAt: nowTs
                };
                await db.collection("inventory").doc(sameItem.id).set(syncPricePayload, { merge: true });
                Object.assign(sameItem, syncPricePayload);
            }

            if (typeof cart !== 'undefined') {
                const isWholesaleMode = (typeof currentActivePosTierWholesale !== 'undefined' && currentActivePosTierWholesale) ||
                                        (typeof isCurrentCustomerWholesale === 'function' && isCurrentCustomerWholesale());
                for (const cKey in cart) {
                    if (cart[cKey].productId === id && !cart[cKey].isGift && !cart[cKey].manualPriceEdited) {
                        const uIdx = cart[cKey].unitIndex || 0;
                        const updatedProd = inventory[oldIdx];
                        if (updatedProd && typeof getStandardUnitPrice === 'function') {
                            cart[cKey].price = getStandardUnitPrice(updatedProd, uIdx, isWholesaleMode);
                            cart[cKey].originalPrice = cart[cKey].price;
                            cart[cKey].costPricePerBase = finalCostPrice;
                        }
                    }
                }
            }

            if (oldItem && oldItem.stock !== stock) {
                const diff = stock - oldItem.stock;
                await writeInventoryLog(id, name, "ADJUST", "SỬA-TỒN", `${diff > 0 ? '+' : ''}${diff} ${baseUnit}`, oldItem.stock, diff, stock);
            }
        }

        renderInventory(false);
        if (typeof renderSellGrid === 'function') renderSellGrid();
        closeProductModal();
    } catch (e) {
        alert("Lỗi khi lưu sản phẩm lên Cloud: " + e.message);
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
    currentPoItems = [];
    renderPoSupplierSelect();
    document.getElementById('po-invoice-no').value = '';
    document.getElementById('po-paid-input').value = '';

    // Xóa trắng ô lọc tìm kiếm mặt hàng mỗi khi mở lại Phiếu Nhập
    if (document.getElementById('po-product-filter')) {
        document.getElementById('po-product-filter').value = '';
    }

    const prodSel = document.getElementById('po-product-id');
    if (prodSel) {
        prodSel.innerHTML = inventory.map(i => `<option value="${i.id}">${i.name} (Tồn: ${i.stock} ${i.baseUnit})</option>`).join('');
    }
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
    const prodId = document.getElementById('po-product-id')?.value;
    const item = inventory.find(i => i.id === prodId);
    const unitSel = document.getElementById('po-unit-select');
    if (!item || !unitSel) {
        if (unitSel) unitSel.innerHTML = '';
        return;
    }

    unitSel.innerHTML = item.units.map((u, idx) => `<option value="${idx}">${u.unitName} (${u.conversionRate} ${item.baseUnit})</option>`).join('') +
        `<option value="CUSTOM">+ Đơn vị lớn khác (Bao/Thùng...)</option>`;
    if (item.units.length > 1) unitSel.selectedIndex = item.units.length - 1;
    onChangePoUnit();
}

function onChangePoUnit() {
    const prodId = document.getElementById('po-product-id')?.value;
    const item = inventory.find(i => i.id === prodId);
    const unitVal = document.getElementById('po-unit-select')?.value;
    const rateInp = document.getElementById('po-conversion-rate');
    if (!item) return;

    if (unitVal === 'CUSTOM') {
        const customUName = prompt(`Nhập tên Đơn Vị Nhập mới cho "${item.name}" (VD: Bao, Thùng, Kiện...):`, "Bao");
        if (!customUName || !customUName.trim()) {
            document.getElementById('po-unit-select').selectedIndex = 0;
            return onChangePoUnit();
        }
        const customRateRaw = prompt(`1 ${customUName.trim()} bằng bao nhiêu ${item.baseUnit} (Hệ số quy đổi)?`, "8");
        const customRate = Math.max(1, parseInt(customRateRaw, 10) || 1);

        const unitSel = document.getElementById('po-unit-select');
        const newOpt = document.createElement('option');
        newOpt.value = `NEW_${customUName.trim()}_${customRate}`;
        newOpt.text = `${customUName.trim()} (${customRate} ${item.baseUnit})`;
        newOpt.dataset.unitName = customUName.trim();
        newOpt.dataset.rate = customRate;
        unitSel.insertBefore(newOpt, unitSel.lastElementChild);
        unitSel.value = newOpt.value;

        if (rateInp) rateInp.value = customRate;
        const suggestedCost = (Number(item.costPrice) || 0) * customRate;
        document.getElementById('po-import-price').value = suggestedCost > 0 ? formatmoney(suggestedCost) : '';
        return;
    }

    if (unitVal && unitVal.startsWith('NEW_')) {
        const selOpt = document.getElementById('po-unit-select').selectedOptions[0];
        const cRate = Math.max(1, parseInt(selOpt?.dataset?.rate, 10) || 1);
        if (rateInp) rateInp.value = cRate;
        const suggestedCost = (Number(item.costPrice) || 0) * cRate;
        document.getElementById('po-import-price').value = suggestedCost > 0 ? formatmoney(suggestedCost) : '';
        return;
    }

    const uIdx = parseInt(unitVal, 10) || 0;
    const u = item.units[uIdx] || item.units[0];
    if (!u) return;

    const rate = Math.max(1, Number(u.conversionRate) || 1);
    if (rateInp) rateInp.value = rate;
    const suggestedCost = (Number(item.costPrice) || 0) * rate;
    document.getElementById('po-import-price').value = suggestedCost > 0 ? formatmoney(suggestedCost) : '';
}

function onChangePoConversionRate() {
    const prodId = document.getElementById('po-product-id')?.value;
    const item = inventory.find(i => i.id === prodId);
    const rate = Math.max(1, parseInt(document.getElementById('po-conversion-rate')?.value, 10) || 1);
    if (item && item.costPrice > 0) {
        document.getElementById('po-import-price').value = formatmoney(item.costPrice * rate);
    }
}

function addPoItemToList() {
    const prodId = document.getElementById('po-product-id')?.value;
    const item = inventory.find(i => i.id === prodId);
    const unitSel = document.getElementById('po-unit-select');
    const unitVal = unitSel?.value || '0';
    const qty = parseInt(document.getElementById('po-qty')?.value, 10) || 0;
    const importPrice = getRawNum('po-import-price');
    const manualRate = Math.max(1, parseInt(document.getElementById('po-conversion-rate')?.value, 10) || 1);

    if (!item || qty <= 0 || importPrice <= 0) {
        return alert("Vui lòng nhập số lượng và đơn giá nhập hợp lệ!");
    }

    let unitName = item.baseUnit;
    if (unitVal.startsWith('NEW_')) {
        unitName = unitSel.selectedOptions[0]?.dataset?.unitName || "Bao";
    } else {
        const uIdx = parseInt(unitVal, 10) || 0;
        unitName = item.units[uIdx] ? item.units[uIdx].unitName : item.baseUnit;
    }

    const conversionRate = manualRate;
    // Công thức chuẩn bán sỉ:
    // 1. Tồn kho cộng thêm = [Số Lượng Nhập] x [Hệ Số Quy Đổi]
    const baseQty = qty * conversionRate;
    // 2. Giá vốn nhập (của ĐVT gốc) = [Đơn Giá Nhập] / [Hệ Số Quy Đổi]
    const costPerBaseAtImport = Math.round(importPrice / conversionRate);
    const totalCost = qty * importPrice;

    const existingIdx = currentPoItems.findIndex(x => x.productId === item.id && x.unitName.toLowerCase() === unitName.toLowerCase() && Number(x.conversionRate) === conversionRate);
    if (existingIdx !== -1) {
        currentPoItems[existingIdx].qty += qty;
        currentPoItems[existingIdx].baseQty = currentPoItems[existingIdx].qty * conversionRate;
        currentPoItems[existingIdx].importPrice = importPrice;
        currentPoItems[existingIdx].costPerBaseAtImport = costPerBaseAtImport;
        currentPoItems[existingIdx].totalCost = currentPoItems[existingIdx].qty * importPrice;
    } else {
        currentPoItems.push({
            productId: item.id,
            barcode: item.barcode || "",
            productName: item.name,
            baseUnit: item.baseUnit,
            unitName: unitName,
            conversionRate: conversionRate,
            qty,
            baseQty,
            importPrice,
            costPerBaseAtImport,
            totalCost,
            isNewProduct: false
        });
    }

    document.getElementById('po-qty').value = 1;
    renderPoItemsTable();
}

function clearPoItemsList() {
    if (currentPoItems.length === 0) return;
    if (confirm("Xóa toàn bộ mặt hàng đang có trong bảng danh sách phiếu nhập này?")) {
        currentPoItems = [];
        renderPoItemsTable();
    }
}

function removePoItem(idx) {
    currentPoItems.splice(idx, 1);
    renderPoItemsTable();
}

// Cho phép sửa trực tiếp Tên ĐVT nhập, Hệ số quy đổi, SL nhập và Đơn giá nhập ngay trên bảng
function updatePoTableItemUnitName(idx, newUnitName) {
    const row = currentPoItems[idx];
    if (!row) return;
    row.unitName = (newUnitName || '').trim() || row.baseUnit || 'Cái';
    renderPoItemsTable();
}

function updatePoTableItemRate(idx, newRateVal) {
    const row = currentPoItems[idx];
    if (!row) return;
    const rate = Math.max(1, parseInt(newRateVal, 10) || 1);
    row.conversionRate = rate;
    // Tính lại Tồn kho cộng thêm = SL Nhập x Hệ Số Quy Đổi
    row.baseQty = row.qty * rate;
    // Tính lại Giá vốn của ĐVT gốc = Đơn Giá Nhập / Hệ Số Quy Đổi
    row.costPerBaseAtImport = Math.round((Number(row.importPrice) || 0) / rate);
    renderPoItemsTable();
}

function updatePoTableItemQty(idx, val) {
    const row = currentPoItems[idx];
    if (!row) return;
    const newQty = Math.max(1, parseInt(val, 10) || 1);
    const rate = Math.max(1, Number(row.conversionRate) || 1);
    row.qty = newQty;
    row.baseQty = newQty * rate;
    row.totalCost = newQty * (Number(row.importPrice) || 0);
    renderPoItemsTable();
}

function updatePoTableItemPrice(idx, inputEl) {
    formatCurrencyInput(inputEl);
    const row = currentPoItems[idx];
    if (!row) return;
    const newPrice = getRawNum(inputEl);
    const rate = Math.max(1, Number(row.conversionRate) || 1);
    row.importPrice = newPrice;
    // Giá vốn nhập (của ĐVT gốc) = [Đơn Giá Nhập] / [Hệ Số Quy Đổi]
    row.costPerBaseAtImport = Math.round(newPrice / rate);
    row.totalCost = row.qty * newPrice;

    const lineTotalEl = document.getElementById(`po-line-total-${idx}`);
    if (lineTotalEl) lineTotalEl.innerText = `${formatmoney(row.totalCost)} đ`;
    const baseCostEl = document.getElementById(`po-base-cost-${idx}`);
    if (baseCostEl) baseCostEl.innerText = `Vốn ĐVT gốc: ${formatmoney(row.costPerBaseAtImport)}đ/${row.baseUnit}`;

    const grandTotal = currentPoItems.reduce((s, i) => s + i.totalCost, 0);
    document.getElementById('po-grand-total').innerText = `${formatmoney(grandTotal)} đ`;
    document.getElementById('po-paid-input').value = formatmoney(grandTotal);
    calcPoDebtPreview();
}

function renderPoItemsTable() {
    const tbody = document.getElementById('po-items-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let grandTotal = 0;
    if (currentPoItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400 italic">Chưa có mặt hàng nào trong phiếu nhập. Hãy chọn mặt hàng ở trên hoặc bấm <b>"Import File Excel"</b>!</td></tr>`;
    } else {
        currentPoItems.forEach((row, idx) => {
            grandTotal += row.totalCost;
            const rate = Math.max(1, Number(row.conversionRate) || 1);
            const newBadge = row.isNewProduct
                ? `<span class="ml-1.5 text-[10px] bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded font-bold">Mới (Tự tạo trong kho)</span>`
                : '';

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2 text-center font-bold">${idx + 1}</td>
                    <td class="p-2 font-bold text-slate-800">
                        <div>${row.productName}${newBadge}</div>
                        <div class="text-[10.5px] text-slate-500 font-normal">
                            ĐVT gốc trên web: <b class="text-slate-700">${row.baseUnit}</b>
                            ${row.barcode ? ` • <i class="fa-solid fa-barcode mr-0.5"></i>${row.barcode}` : ''}
                        </div>
                    </td>
                    <td class="p-2 text-center">
                        <div class="flex flex-col items-center gap-1">
                            <input type="text" value="${row.unitName}" onchange="updatePoTableItemUnitName(${idx}, this.value)" class="w-20 border border-slate-300 rounded p-1 text-center text-xs font-bold text-inni-blue bg-white" title="Đơn vị nhập trên hóa đơn NPP">
                            <div class="flex items-center gap-1 text-[10px] text-amber-800 font-bold">
                                <span>×</span>
                                <input type="number" min="1" value="${rate}" onchange="updatePoTableItemRate(${idx}, this.value)" class="w-12 border border-amber-400 bg-amber-50 rounded px-1 py-0.5 text-center font-black text-amber-900" title="Hệ số quy đổi ra ${row.baseUnit}">
                                <span>${row.baseUnit}</span>
                            </div>
                        </div>
                    </td>
                    <td class="p-2 text-center">
                        <input type="number" min="1" value="${row.qty}" onchange="updatePoTableItemQty(${idx}, this.value)" class="w-14 border border-slate-300 rounded p-1 text-center font-black text-xs bg-white">
                    </td>
                    <td class="p-2 text-center">
                        <div class="text-emerald-700 font-black whitespace-nowrap">+${row.baseQty} ${row.baseUnit}</div>
                        <div class="text-[10px] text-slate-400">(${row.qty} ${row.unitName} × ${rate})</div>
                    </td>
                    <td class="p-2 text-right">
                        <input type="text" value="${formatmoney(row.importPrice)}" oninput="updatePoTableItemPrice(${idx}, this)" class="w-24 border border-emerald-400 bg-emerald-50/30 focus:bg-white rounded p-1 text-right font-bold text-emerald-700 text-xs focus:outline-none">
                        <div class="text-[10px] text-slate-500 mt-0.5 whitespace-nowrap" id="po-base-cost-${idx}">
                            Vốn ĐVT gốc: <b class="text-slate-700">${formatmoney(row.costPerBaseAtImport)}đ/${row.baseUnit}</b>
                        </div>
                    </td>
                    <td class="p-2 text-right font-black text-red-600 whitespace-nowrap" id="po-line-total-${idx}">${formatmoney(row.totalCost)} đ</td>
                    <td class="p-2 text-center">
                        <button onclick="removePoItem(${idx})" class="text-red-500 hover:text-red-700 px-1.5 py-1"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    }

    document.getElementById('po-grand-total').innerText = `${formatmoney(grandTotal)} đ`;
    document.getElementById('po-paid-input').value = formatmoney(grandTotal);
    calcPoDebtPreview();
}

// 1. Sửa lại File Excel mẫu Phiếu Nhập: Bắt buộc có cột "Hệ Số Quy Đổi" và ví dụ thực tế Snack 5k (1 Bao = 8 Lốc)
function downloadPoSampleExcel() {
    const sampleRows = [
        {
            "Mã Hàng": "SNACK5K",
            "Tên Hàng Hóa": "Snack 5k",
            "ĐVT Gốc (Trên Web)": "Lốc",
            "Đơn Vị Nhập": "Bao",
            "Hệ Số Quy Đổi": 8,
            "Số Lượng Nhập": 5,
            "Đơn Giá Nhập": 280000
        },
        {
            "Mã Hàng": "893482211234",
            "Tên Hàng Hóa": "Bia Sài Gòn Lager",
            "ĐVT Gốc (Trên Web)": "Lon",
            "Đơn Vị Nhập": "Thùng",
            "Hệ Số Quy Đổi": 24,
            "Số Lượng Nhập": 20,
            "Đơn Giá Nhập": 276000
        }
    ];
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mau_Phieu_Nhap");
    XLSX.writeFile(wb, "File_Mau_Phieu_Nhap_Hang.xlsx");
}

// 2. Viết lại hàm xử lý Import Phiếu Nhập Hàng trên web với cơ chế Hệ Số Quy Đổi
function handleImportPoExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

            if (rows.length === 0) {
                event.target.value = '';
                return alert("File Excel trống, không có dữ liệu!");
            }

            let matchedCount = 0;
            let newProdCount = 0;

            rows.forEach(r => {
                const normRow = {};
                Object.keys(r).forEach(colName => {
                    const nk = normalizeExcelColKey(colName);
                    if (nk && (normRow[nk] === undefined || normRow[nk] === "")) {
                        normRow[nk] = r[colName];
                    }
                });

                const barcode = getExcelColVal(normRow, [
                    "mahang", "mahanghoa", "mavach", "masku", "sku", "barcode", "masp", "masanpham", "ma"
                ]).toString().trim();

                const name = getExcelColVal(normRow, [
                    "tenhanghoa", "tenhang", "tensanpham", "tenmathang", "ten", "name", "sanpham", "hanghoa"
                ]).toString().trim();

                if (!barcode && !name) return;

                const rawBaseUnitFromExcel = getExcelColVal(normRow, [
                    "dvtgoctrenweb", "dvtgoc", "donvigoc", "donvile", "donvicoban", "baseunit"
                ]).toString().trim();

                const rawUnit = getExcelColVal(normRow, [
                    "donvinhap", "donvitinh", "dvt", "donvi", "unit", "quycach", "donvithung"
                ]).toString().trim();

                // Đọc cột "Hệ Số Quy Đổi" (hoặc Quy đổi, Tỷ lệ) từ file Excel
                const rawExcelRate = parseExcelNum(getExcelColVal(normRow, [
                    "hesoquydoi", "quydoi", "quydoiradvtgoc", "tylequydoi", "tilequydoi", "tyle", "tile", "heso", "slquydoi", "conversionrate", "rate"
                ]));

                const rawQty = parseExcelNum(getExcelColVal(normRow, [
                    "soluongnhap", "soluong", "slnhap", "sl", "qty", "quantity", "soluongton"
                ]));
                const qty = rawQty > 0 ? rawQty : 1;

                const rawPrice = parseExcelNum(getExcelColVal(normRow, [
                    "dongianhap", "gianhap", "dongia", "giavon", "gia", "importprice", "cost", "costprice", "price"
                ]));

                const rawTotal = parseExcelNum(getExcelColVal(normRow, [
                    "thanhtien", "tongtien", "total", "amount"
                ]));

                // Tìm mặt hàng trong kho theo Mã hàng / Mã vạch hoặc Tên hàng hóa
                const normBc = barcode.toLowerCase();
                const normName = name.toLowerCase();
                let matchedProd = null;
                let matchedUnitByBarcodeIdx = -1;

                if (normBc) {
                    for (const item of inventory) {
                        if (item.barcode && item.barcode.toLowerCase() === normBc) {
                            matchedProd = item;
                            break;
                        }
                        if (Array.isArray(item.units)) {
                            const uIdx = item.units.findIndex(u => u.barcode && u.barcode.toLowerCase() === normBc);
                            if (uIdx !== -1) {
                                matchedProd = item;
                                matchedUnitByBarcodeIdx = uIdx;
                                break;
                            }
                        }
                    }
                }

                if (!matchedProd && normName) {
                    matchedProd = inventory.find(item => (item.name || '').trim().toLowerCase() === normName);
                }

                if (matchedProd) {
                    // Xác định Tên Đơn Vị Nhập & Hệ Số Quy Đổi:
                    // Ưu tiên 1: Nếu file Excel có điền cột [Hệ Số Quy Đổi] (> 0) thì lấy chính xác theo Excel (VD: Bao = 8 Lốc)
                    // Ưu tiên 2: Nếu Excel bỏ trống cột Hệ Số Quy Đổi, tự động dò trong danh sách units của sản phẩm
                    let unitName = rawUnit;
                    let convRate = rawExcelRate;

                    const existingUnitObj = rawUnit
                        ? (matchedProd.units || []).find(u => (u.unitName || '').trim().toLowerCase() === rawUnit.toLowerCase())
                        : (matchedUnitByBarcodeIdx !== -1 ? matchedProd.units[matchedUnitByBarcodeIdx] : null);

                    if (!unitName) {
                        if (existingUnitObj) {
                            unitName = existingUnitObj.unitName;
                        } else if (convRate === 1) {
                            unitName = matchedProd.baseUnit;
                        } else if (matchedProd.units && matchedProd.units.length > 1) {
                            unitName = matchedProd.units[matchedProd.units.length - 1].unitName;
                        } else {
                            unitName = matchedProd.baseUnit;
                        }
                    }

                    if (convRate <= 0) {
                        if (existingUnitObj && Number(existingUnitObj.conversionRate) > 0) {
                            convRate = Number(existingUnitObj.conversionRate);
                        } else if (unitName.toLowerCase() === (matchedProd.baseUnit || '').toLowerCase()) {
                            convRate = 1;
                        } else if (!rawUnit && matchedProd.units && matchedProd.units.length > 1) {
                            convRate = Number(matchedProd.units[matchedProd.units.length - 1].conversionRate) || 1;
                        } else {
                            convRate = 1;
                        }
                    }

                    let importPrice = rawPrice;
                    if (importPrice <= 0 && rawTotal > 0 && qty > 0) {
                        importPrice = Math.round(rawTotal / qty);
                    }
                    if (importPrice <= 0) {
                        importPrice = (Number(matchedProd.costPrice) || 0) * convRate;
                    }

                    // ÁP DỤNG CÔNG THỨC CHUẨN BÁN SỈ:
                    // - Tồn kho cộng thêm = [Số Lượng Nhập] x [Hệ Số Quy Đổi]
                    const baseQty = qty * convRate;
                    // - Giá vốn nhập (của ĐVT gốc) = [Đơn Giá Nhập] / [Hệ Số Quy Đổi]
                    const costPerBaseAtImport = Math.round(importPrice / convRate);
                    const totalCost = qty * importPrice;

                    const existIdx = currentPoItems.findIndex(
                        x => x.productId === matchedProd.id &&
                             x.unitName.toLowerCase() === unitName.toLowerCase() &&
                             Number(x.conversionRate) === convRate
                    );

                    if (existIdx !== -1) {
                        currentPoItems[existIdx].qty += qty;
                        currentPoItems[existIdx].baseQty = currentPoItems[existIdx].qty * convRate;
                        if (importPrice > 0) {
                            currentPoItems[existIdx].importPrice = importPrice;
                            currentPoItems[existIdx].costPerBaseAtImport = costPerBaseAtImport;
                        }
                        currentPoItems[existIdx].totalCost = currentPoItems[existIdx].qty * currentPoItems[existIdx].importPrice;
                    } else {
                        currentPoItems.push({
                            productId: matchedProd.id,
                            barcode: barcode || matchedProd.barcode || "",
                            productName: matchedProd.name,
                            baseUnit: matchedProd.baseUnit,
                            unitName: unitName,
                            conversionRate: convRate,
                            qty: qty,
                            baseQty: baseQty,
                            importPrice: importPrice,
                            costPerBaseAtImport: costPerBaseAtImport,
                            totalCost: totalCost,
                            isNewProduct: false
                        });
                    }
                    matchedCount++;
                } else {
                    // Nếu mặt hàng hoàn toàn mới chưa có trên web -> Vẫn tính đúng quy đổi ra ĐVT gốc
                    const convRate = rawExcelRate > 0 ? rawExcelRate : 1;
                    const unitName = rawUnit || (convRate > 1 ? "Thùng" : "Cái");
                    const baseUnit = rawBaseUnitFromExcel || (convRate > 1 ? "Lốc" : unitName);

                    let importPrice = rawPrice;
                    if (importPrice <= 0 && rawTotal > 0 && qty > 0) {
                        importPrice = Math.round(rawTotal / qty);
                    }

                    const baseQty = qty * convRate;
                    const costPerBaseAtImport = Math.round(importPrice / convRate);
                    const totalCost = qty * importPrice;

                    currentPoItems.push({
                        productId: "NEW_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
                        barcode: barcode,
                        productName: name || `Hàng mã ${barcode}`,
                        baseUnit: baseUnit,
                        unitName: unitName,
                        conversionRate: convRate,
                        qty: qty,
                        baseQty: baseQty,
                        importPrice: importPrice,
                        costPerBaseAtImport: costPerBaseAtImport,
                        totalCost: totalCost,
                        isNewProduct: true
                    });
                    newProdCount++;
                }
            });

            event.target.value = '';
            renderPoItemsTable();
            alert(
                `✅ Đã Import File Excel Phiếu Nhập Hàng thành công!\n` +
                `- Khớp sản phẩm trong kho: ${matchedCount} dòng\n` +
                (newProdCount > 0 ? `- Sản phẩm mới (sẽ tự tạo vào kho khi chốt): ${newProdCount} dòng\n` : '') +
                `\nĐã tự động nhân [Hệ Số Quy Đổi] để tính số lượng cộng kho và chia [Đơn Giá Nhập] để ra Giá vốn ĐVT gốc!`
            );
        } catch (err) {
            event.target.value = '';
            alert("Lỗi đọc file Excel phiếu nhập: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
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
        for (const pItem of currentPoItems) {
            const convRate = Math.max(1, Number(pItem.conversionRate) || 1);
            // Đảm bảo tính chuẩn xác một lần nữa trước khi ghi vào Database:
            // - Tồn kho cộng thêm = [Số Lượng Nhập] x [Hệ Số Quy Đổi]
            pItem.baseQty = pItem.qty * convRate;
            // - Giá vốn nhập của ĐVT gốc = [Đơn Giá Nhập] / [Hệ Số Quy Đổi]
            pItem.costPerBaseAtImport = Math.round((Number(pItem.importPrice) || 0) / convRate);
            pItem.totalCost = pItem.qty * (Number(pItem.importPrice) || 0);

            let dbProd = inventory.find(i => i.id === pItem.productId);

            // Trường hợp 1: Mặt hàng mới tinh trong file Excel -> Tự động tạo sản phẩm mới vào Kho với đúng ĐVT gốc & ĐVT quy đổi
            if (!dbProd) {
                const baseUnitName = pItem.baseUnit || "Lốc";
                const defaultBaseSellPrice = pItem.costPerBaseAtImport > 0 ? Math.round(pItem.costPerBaseAtImport * 1.15) : 0;
                const unitsArr = [{
                    unitName: baseUnitName,
                    conversionRate: 1,
                    sellingPrice: defaultBaseSellPrice,
                    wholesalePrice: defaultBaseSellPrice,
                    barcode: pItem.barcode || ""
                }];

                if (convRate > 1 && pItem.unitName && pItem.unitName.toLowerCase() !== baseUnitName.toLowerCase()) {
                    const bigSellPrice = defaultBaseSellPrice * convRate;
                    unitsArr.push({
                        unitName: pItem.unitName,
                        conversionRate: convRate,
                        sellingPrice: bigSellPrice,
                        wholesalePrice: bigSellPrice,
                        barcode: ""
                    });
                }

                const newProdData = {
                    name: pItem.productName,
                    category: "Khác",
                    barcode: pItem.barcode || "",
                    keywords: [],
                    image: null,
                    baseUnit: baseUnitName,
                    costPrice: pItem.costPerBaseAtImport || 0,
                    basePrice: defaultBaseSellPrice,
                    wholesalePrice: defaultBaseSellPrice,
                    price: defaultBaseSellPrice,
                    stock: pItem.baseQty,
                    minStock: 24,
                    units: unitsArr,
                    createdAt: Date.now()
                };
                const newDocRef = await db.collection("inventory").add(newProdData);
                pItem.productId = newDocRef.id;
                await writeInventoryLog(
                    newDocRef.id, pItem.productName, "IMPORT", `${poCode} (${supplierName})`,
                    `+${pItem.qty} ${pItem.unitName} (×${convRate} = +${pItem.baseQty} ${baseUnitName})`,
                    0, pItem.baseQty, pItem.baseQty
                );
            } else {
                // Trường hợp 2: Mặt hàng đã có trong kho -> Cộng tồn theo baseQty và cập nhật Giá vốn ĐVT gốc
                const curStock = Math.max(0, Number(dbProd.stock) || 0);
                const oldCost = Number(dbProd.costPrice) || 0;

                // Tính giá vốn bình quân gia quyền cho 1 ĐVT gốc (hoặc lấy luôn giá vốn mới nếu trước đó giá vốn = 0)
                const newMacCost = (curStock > 0 && oldCost > 0)
                    ? Math.round(((curStock * oldCost) + (pItem.baseQty * pItem.costPerBaseAtImport)) / (curStock + pItem.baseQty))
                    : pItem.costPerBaseAtImport;

                const newStock = (Number(dbProd.stock) || 0) + pItem.baseQty;

                // Nếu Đơn vị nhập (VD: "Bao", quy đổi = 8) chưa có trong danh mục đơn vị của sản phẩm thì tự động lưu thêm vào units để lần sau dùng luôn
                const updatedUnits = Array.isArray(dbProd.units) ? dbProd.units.map(u => ({ ...u })) : [];
                if (convRate > 1 && pItem.unitName) {
                    const existUIdx = updatedUnits.findIndex(u => (u.unitName || '').toLowerCase() === pItem.unitName.toLowerCase());
                    if (existUIdx === -1) {
                        const baseRetail = Number(dbProd.basePrice) || pItem.costPerBaseAtImport;
                        const baseWhole = Number(dbProd.wholesalePrice) || baseRetail;
                        updatedUnits.push({
                            unitName: pItem.unitName,
                            conversionRate: convRate,
                            sellingPrice: baseRetail * convRate,
                            wholesalePrice: baseWhole * convRate,
                            barcode: ""
                        });
                    }
                }

                await db.collection("inventory").doc(dbProd.id).update({
                    stock: newStock,
                    costPrice: newMacCost > 0 ? newMacCost : oldCost,
                    units: updatedUnits
                });

                await writeInventoryLog(
                    dbProd.id, dbProd.name, "IMPORT", `${poCode} (${supplierName})`,
                    `+${pItem.qty} ${pItem.unitName} (×${convRate} = +${pItem.baseQty} ${dbProd.baseUnit} • Vốn nhập: ${formatmoney(pItem.costPerBaseAtImport)}đ/${dbProd.baseUnit})`,
                    dbProd.stock, pItem.baseQty, newStock
                );
            }
        }

        const newPoRecord = {
            poCode,
            invoiceNo: invoiceNo || poCode,
            supplierId,
            supplierName,
            items: currentPoItems.map(x => ({ ...x })),
            totalAmount: grandTotal,
            paidAmount,
            debtAmount: remainDebt,
            paymentMethod: payMethod,
            dateStr,
            createdAt: Date.now()
        };

        await db.collection("purchase_orders").doc(poCode).set(newPoRecord);

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

        // CẬP NHẬT NGAY LẬP TỨC DANH SÁCH ĐƠN NHẬP HÀNG (KHÔNG CẦN BẤM BACK RA VÀO LẠI)
        if (typeof cachedPurchaseOrders !== 'undefined') {
            cachedPurchaseOrders = [newPoRecord, ...cachedPurchaseOrders.filter(p => p.poCode !== poCode)];
            if (typeof renderPoListScreen === 'function') renderPoListScreen(true);
        }
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) {
            openPoHistoryModal();
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
        const snap = await db.collection("purchase_orders").limit(100).get();
        const pos = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        cachedPurchaseOrders = pos;
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

            const hasReturnBadge = (Array.isArray(po.returnHistory) && po.returnHistory.length > 0)
                ? `<span class="ml-1 text-[10px] bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded font-bold">Đã hoàn trả NPP</span>`
                : '';

            tbody.innerHTML += `
                <tr onclick="openPoDetailModal('${po.poCode}')" class="hover:bg-blue-50/50 cursor-pointer transition" title="Bấm để xem Chi tiết phiếu nhập & Hoàn trả NPP">
                    <td class="p-2.5">
                        <div class="font-bold text-emerald-700 flex items-center flex-wrap gap-1">${po.poCode} ${hasReturnBadge}</div>
                        <div class="text-xs text-slate-400">${dStr}</div>
                    </td>
                    <td class="p-2.5">
                        <div class="font-bold text-slate-800">${po.supplierName}</div>
                        <div class="text-xs text-slate-500">Số HĐ: ${po.invoiceNo || '---'}</div>
                    </td>
                    <td class="p-2.5 text-xs text-slate-700 space-y-0.5">${itemsHtml || '<span class="italic text-slate-400">Đã hoàn trả hết hàng</span>'}</td>
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

function downloadProductSampleExcel() {
    const sampleData = [
        {
            "Tên Hàng Hóa": "Bia Sài Gòn Lager",
            "Phân loại": "Bia & Rượu",
            "Mã Vạch": "893482211234",
            "Đơn vị lẻ": "Lon",
            "Tỷ Lệ": 1,
            "Giá Vốn": 11500,
            "Giá Bán Lẻ": 14000,
            "Giá Sỉ": 12500,
            "Đơn vị lốc": "Lốc",
            "Quy đổi lốc": 6,
            "Giá bán lốc": 80000,
            "Giá sỉ lốc": 75000,
            "Đơn vị thùng": "Thùng",
            "Quy đổi thùng": 24,
            "Giá bán thùng": 310000,
            "Giá sỉ thùng": 295000,
            "Số lượng tồn": 1095,
            "Báo động tồn": 24,
            "Từ khóa Zalo": "sai gon, sg xanh"
        }
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mau_Kho_Hang");
    XLSX.writeFile(wb, "File_Mau_Import_Kho_Hang.xlsx");
}

// Xuất toàn bộ danh sách sản phẩm thực tế đang có trong Kho ra file Excel (.xlsx)
function exportProductsToExcel() {
    if (!Array.isArray(inventory) || inventory.length === 0) {
        return alert("Kho hàng hiện đang trống, chưa có mặt hàng nào để xuất!");
    }

    const exportRows = inventory.map((item, idx) => {
        const extraUnits = (Array.isArray(item.units) ? item.units : [])
            .filter(u => Number(u.conversionRate) > 1)
            .sort((a, b) => Number(a.conversionRate) - Number(b.conversionRate));

        let packUnitObj = null;
        let bigUnitObj = null;

        if (extraUnits.length === 1) {
            const u = extraUnits[0];
            const uNorm = (u.unitName || '').toLowerCase();
            if (Number(u.conversionRate) >= 12 || uNorm.includes('thùng') || uNorm.includes('thung') || uNorm.includes('két') || uNorm.includes('bao')) {
                bigUnitObj = u;
            } else {
                packUnitObj = u;
            }
        } else if (extraUnits.length >= 2) {
            packUnitObj = extraUnits[0];
            bigUnitObj = extraUnits[extraUnits.length - 1];
        }

        return {
            "STT": idx + 1,
            "Tên Hàng Hóa": item.name || "",
            "Phân loại": item.category || "Khác",
            "Mã Vạch": item.barcode || "",
            "Đơn vị lẻ": item.baseUnit || "Cái",
            "Tỷ Lệ": 1,
            "Giá Vốn": Number(item.costPrice) || 0,
            "Giá Bán Lẻ": Number(item.basePrice) || 0,
            "Giá Sỉ": Number(item.wholesalePrice ?? item.basePrice) || 0,
            "Đơn vị lốc": packUnitObj ? packUnitObj.unitName : "",
            "Quy đổi lốc": packUnitObj ? Number(packUnitObj.conversionRate) : "",
            "Giá bán lốc": packUnitObj ? Number(packUnitObj.sellingPrice) : "",
            "Giá sỉ lốc": packUnitObj ? Number(packUnitObj.wholesalePrice ?? packUnitObj.sellingPrice) : "",
            "Đơn vị thùng": bigUnitObj ? bigUnitObj.unitName : "",
            "Quy đổi thùng": bigUnitObj ? Number(bigUnitObj.conversionRate) : "",
            "Giá bán thùng": bigUnitObj ? Number(bigUnitObj.sellingPrice) : "",
            "Giá sỉ thùng": bigUnitObj ? Number(bigUnitObj.wholesalePrice ?? bigUnitObj.sellingPrice) : "",
            "Số lượng tồn": Number(item.stock) || 0,
            "Báo động tồn": Number(item.minStock ?? 24),
            "Từ khóa Zalo": Array.isArray(item.keywords) ? item.keywords.join(', ') : ""
        };
    });

    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Danh_Sach_Kho_Hang");
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Danh_Sach_Kho_Hang_${dateStr}.xlsx`);
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

                    const rawCategory = getExcelColVal(normRow, [
                        "phanloai", "loaisanpham", "nhomhang", "danhmuc", "loai", "category"
                    ]).toString().trim();

                    const barcode = getExcelColVal(normRow, [
                        "mavach", "masku", "sku", "barcode", "mahang", "mahanghoa"
                    ]).toString().trim();

                    const baseUnit = getExcelColVal(normRow, [
                        "donvile", "donvitinh", "donvi", "dvt", "donvicoban", "donvinho", "unit"
                    ]).toString().trim() || "Cái";

                    const rawCost = parseExcelNum(getExcelColVal(normRow, [
                        "giavon", "gianhap", "dongianhap", "giavonthung", "giavonloc", "cost", "costprice"
                    ]));
                    const rawRatio = parseExcelNum(getExcelColVal(normRow, [
                        "tyle", "tile", "heso", "quydoi", "tylequydoi", "slquydoi", "rate"
                    ]));
                    const ratio = rawRatio > 0 ? rawRatio : 1;
                    const calculatedCoreCost = rawCost > 0 ? Math.round(rawCost / ratio) : 0;

                    const rawSellPrice = parseExcelNum(getExcelColVal(normRow, [
                        "giaban", "giabanle", "giale", "dongia", "dongiaban", "gia", "price", "sellingprice"
                    ]));
                    const rawWholesalePrice = parseExcelNum(getExcelColVal(normRow, [
                        "giasi", "giabansi", "dongiasi", "giasile", "wholesaleprice"
                    ]));

                    const rawStockStr = getExcelColVal(normRow, [
                        "soluongton", "tonkho", "ton", "soluong", "slton", "stock"
                    ]);
                    const hasStockCol = rawStockStr !== "";
                    const stock = parseExcelNum(rawStockStr);

                    const rawMinStockStr = getExcelColVal(normRow, [
                        "baodongton", "dinhmucton", "tonitnhat", "minstock"
                    ]);
                    const hasMinStockCol = rawMinStockStr !== "";
                    const minStock = parseExcelNum(rawMinStockStr);

                    const kwStr = getExcelColVal(normRow, ["tukhoazalo", "tukhoa", "keywords"]).toString().trim();
                    const keywords = kwStr ? kwStr.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];

                    const packUnit = getExcelColVal(normRow, ["donviloc", "dvloc"]).toString().trim();
                    const packRate = parseExcelNum(getExcelColVal(normRow, ["quydoiloc", "tyleloc"]));
                    const rawPackPrice = parseExcelNum(getExcelColVal(normRow, ["giabanloc", "gialoc", "gialeloc"]));
                    const rawPackWholesale = parseExcelNum(getExcelColVal(normRow, ["giasiloc", "giabansiloc"]));

                    const bigUnit = getExcelColVal(normRow, ["donvithung", "dvthung"]).toString().trim();
                    const bigRate = parseExcelNum(getExcelColVal(normRow, ["quydoithung", "tylethung"]));
                    const rawBigPrice = parseExcelNum(getExcelColVal(normRow, ["giabanthung", "giathung", "gialethung"]));
                    const rawBigWholesale = parseExcelNum(getExcelColVal(normRow, ["giasithung", "giabansithung"]));

                    const normName = name.toLowerCase();
                    const normBc = barcode.toLowerCase();
                    const existingItem = workingCatalog.find(item => {
                        if (normBc && item.barcode && item.barcode.toLowerCase() === normBc) return true;
                        if (normBc && Array.isArray(item.units) && item.units.some(u => u.barcode && u.barcode.toLowerCase() === normBc)) return true;
                        return (item.name || '').trim().toLowerCase() === normName;
                    });

                    if (existingItem) {
                        const finalCostPrice = calculatedCoreCost > 0 ? calculatedCoreCost : (existingItem.costPrice || 0);
                        const finalBasePrice = rawSellPrice > 0 ? rawSellPrice : (existingItem.basePrice || 0);
                        const finalWholesalePrice = rawWholesalePrice > 0 ? rawWholesalePrice : (rawSellPrice > 0 ? rawSellPrice : (existingItem.wholesalePrice || finalBasePrice));
                        const finalBaseUnit = baseUnit || existingItem.baseUnit || "Cái";
                        const finalCategory = rawCategory || existingItem.category || "Khác";
                        const finalKeywords = kwStr !== "" ? keywords : (existingItem.keywords || []);

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

                        const packRetail = rawPackPrice || rawPackWholesale || (packRate > 1 ? finalBasePrice * packRate : 0);
                        const packWhole = rawPackWholesale || rawPackPrice || (packRate > 1 ? finalWholesalePrice * packRate : 0);
                        if (packUnit && packRate > 1 && packRetail > 0) {
                            const pIdx = updatedUnits.findIndex(u => u.unitName.toLowerCase() === packUnit.toLowerCase() || Number(u.conversionRate) === packRate);
                            if (pIdx !== -1) {
                                updatedUnits[pIdx] = { ...updatedUnits[pIdx], unitName: packUnit, conversionRate: packRate, sellingPrice: packRetail, wholesalePrice: packWhole };
                            } else {
                                updatedUnits.push({ unitName: packUnit, conversionRate: packRate, sellingPrice: packRetail, wholesalePrice: packWhole, barcode: "" });
                            }
                        }

                        const bigRetail = rawBigPrice || rawBigWholesale || (bigRate > 1 ? finalBasePrice * bigRate : 0);
                        const bigWhole = rawBigWholesale || rawBigPrice || (bigRate > 1 ? finalWholesalePrice * bigRate : 0);
                        if (bigUnit && bigRate > 1 && bigRetail > 0) {
                            const bIdx = updatedUnits.findIndex(u => u.unitName.toLowerCase() === bigUnit.toLowerCase() || Number(u.conversionRate) === bigRate);
                            if (bIdx !== -1) {
                                updatedUnits[bIdx] = { ...updatedUnits[bIdx], unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigRetail, wholesalePrice: bigWhole };
                            } else {
                                updatedUnits.push({ unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigRetail, wholesalePrice: bigWhole, barcode: "" });
                            }
                        }

                        const updatePayload = {
                            name,
                            category: finalCategory,
                            keywords: finalKeywords,
                            baseUnit: finalBaseUnit,
                            costPrice: finalCostPrice,
                            basePrice: finalBasePrice,
                            wholesalePrice: finalWholesalePrice,
                            price: finalBasePrice,
                            units: updatedUnits
                        };
                        if (barcode) updatePayload.barcode = barcode;
                        if (hasStockCol) updatePayload.stock = stock;
                        if (hasMinStockCol) updatePayload.minStock = minStock;

                        const docRef = db.collection("inventory").doc(existingItem.id);
                        batch.update(docRef, updatePayload);

                        Object.assign(existingItem, updatePayload);
                        updatedCount++;
                    } else {
                        const finalBasePrice = rawSellPrice || rawBigPrice || 0;
                        const finalWholesalePrice = rawWholesalePrice || finalBasePrice;
                        const finalCostPrice = calculatedCoreCost > 0 ? calculatedCoreCost : Math.round(finalBasePrice * 0.85);

                        const units = [{ unitName: baseUnit, conversionRate: 1, sellingPrice: finalBasePrice, wholesalePrice: finalWholesalePrice, barcode }];

                        const packRetail = rawPackPrice || rawPackWholesale || (finalBasePrice * packRate);
                        const packWhole = rawPackWholesale || rawPackPrice || (finalWholesalePrice * packRate);
                        if (packUnit && packRate > 1 && packRetail > 0) {
                            units.push({ unitName: packUnit, conversionRate: packRate, sellingPrice: packRetail, wholesalePrice: packWhole, barcode: "" });
                        }

                        const bigRetail = rawBigPrice || rawBigWholesale || (finalBasePrice * bigRate);
                        const bigWhole = rawBigWholesale || rawBigPrice || (finalWholesalePrice * bigRate);
                        if (bigUnit && bigRate > 1 && bigRetail > 0) {
                            units.push({ unitName: bigUnit, conversionRate: bigRate, sellingPrice: bigRetail, wholesalePrice: bigWhole, barcode: "" });
                        }

                        const docRef = db.collection("inventory").doc();
                        const newProdObj = {
                            name,
                            category: rawCategory || "Khác",
                            barcode,
                            keywords,
                            baseUnit,
                            costPrice: finalCostPrice,
                            basePrice: finalBasePrice,
                            wholesalePrice: finalWholesalePrice,
                            price: finalBasePrice,
                            stock,
                            minStock: hasMinStockCol ? minStock : 24,
                            units,
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
// MÀN HÌNH ĐỘC LẬP TRONG MENU SẢN PHẨM: ĐƠN NHẬP HÀNG, CHI TIẾT & HOÀN TRẢ NPP (MODULE 6.3)
// ==========================================
let cachedPurchaseOrders = [];
let poScreenLimit = 40;
let currentViewingPo = null;

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
            ? `<span class="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">Nợ NPP: ${formatmoney(po.debtAmount)}đ</span>`
            : `<span class="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Hoàn thành</span>`;

        const returnBadge = (Array.isArray(po.returnHistory) && po.returnHistory.length > 0)
            ? `<span class="text-[10px] font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded ml-1">Đã hoàn trả</span>`
            : '';

        const itemCount = Array.isArray(po.items) ? po.items.length : 0;

        return `
            <div onclick="openPoDetailModal('${po.poCode}')" class="p-3.5 flex justify-between items-center hover:bg-blue-50/40 active:bg-slate-100 cursor-pointer transition">
                <div class="space-y-0.5">
                    <div class="font-bold text-slate-800 text-sm flex items-center flex-wrap gap-1">
                        <span>${po.poCode}</span>
                        ${returnBadge}
                    </div>
                    <div class="text-xs text-slate-600 font-medium">${po.supplierName || 'Nhà cung cấp lẻ'} <span class="text-slate-400 font-normal">(${itemCount} món)</span></div>
                    <div class="text-[11px] text-slate-400">${dStr}</div>
                </div>
                <div class="text-right space-y-1 flex items-center gap-2">
                    <div>
                        <div class="font-bold text-slate-800 text-sm">${formatmoney(po.totalAmount)} đ</div>
                        <div>${statusBadge}</div>
                    </div>
                    <i class="fa-solid fa-chevron-right text-slate-300 text-xs"></i>
                </div>
            </div>
        `;
    }).join('');
}

// Mở trang Chi Tiết Phiếu Nhập khi click vào 1 phiếu bất kỳ
async function openPoDetailModal(poCode) {
    let po = cachedPurchaseOrders.find(p => p.poCode === poCode);
    if (!po) {
        try {
            const docSnap = await db.collection("purchase_orders").doc(poCode).get();
            if (docSnap.exists) po = docSnap.data();
        } catch (e) {}
    }
    if (!po) return alert("Không tìm thấy dữ liệu phiếu nhập này!");

    currentViewingPo = po;
    const dStr = new Date(po.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

    document.getElementById('pod-code').innerText = po.poCode || '';
    document.getElementById('pod-date').innerText = dStr;
    document.getElementById('pod-supplier').innerText = po.supplierName || 'Nhà Cung Cấp Lẻ';
    document.getElementById('pod-invoice-no').innerText = po.invoiceNo || po.poCode || '---';

    const items = Array.isArray(po.items) ? po.items : [];
    const tbody = document.getElementById('pod-items-tbody');

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 italic">Tất cả mặt hàng trong phiếu này đã được hoàn trả hết cho Nhà Cung Cấp.</td></tr>`;
    } else {
        tbody.innerHTML = items.map((item, idx) => {
            const rate = Math.max(1, Number(item.conversionRate) || 1);
            const bUnit = item.baseUnit || item.unitName || 'Cái';
            const baseQty = Number(item.baseQty) || (Number(item.qty) * rate);
            const rateNote = rate > 1
                ? `<div class="text-[10px] text-emerald-700 font-normal">Quy đổi: 1 ${item.unitName} = ${rate} ${bUnit} (+${baseQty} ${bUnit})</div>`
                : '';
            const retNote = (Number(item.returnedQty) || 0) > 0
                ? `<div class="text-[10px] text-amber-700 font-semibold">Đã trả NPP: ${item.returnedQty} ${item.unitName}</div>`
                : '';

            return `
                <tr class="hover:bg-slate-50">
                    <td class="p-2 text-center font-semibold text-slate-500">${idx + 1}</td>
                    <td class="p-2 font-bold text-slate-800">
                        <div>${item.productName}</div>
                        ${rateNote}
                        ${retNote}
                    </td>
                    <td class="p-2 text-center font-semibold text-inni-blue">${item.unitName}</td>
                    <td class="p-2 text-center font-black text-slate-800">${item.qty}</td>
                    <td class="p-2 text-right font-medium text-slate-700">${formatmoney(item.importPrice)} đ</td>
                    <td class="p-2 text-right font-black text-red-600">${formatmoney(item.totalCost)} đ</td>
                </tr>
            `;
        }).join('');
    }

    // Hiển thị lịch sử các lần hoàn trả trước đó (Có nút Sửa & Xóa phiếu hoàn cho nhẹ dữ liệu)
    const retBox = document.getElementById('pod-return-history-box');
    const retList = document.getElementById('pod-return-history-list');
    if (Array.isArray(po.returnHistory) && po.returnHistory.length > 0) {
        retBox.classList.remove('hidden');
        retList.innerHTML = po.returnHistory.map((rh, rIdx) => {
            const rTime = new Date(rh.returnedAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `
                <div class="flex items-center justify-between gap-2 bg-white/80 px-2.5 py-1.5 rounded-lg border border-amber-200/80">
                    <div class="flex-1 min-w-0">
                        <span class="font-bold text-amber-900">[${rh.returnCode || 'Hoàn #' + (rIdx + 1)}]</span>
                        <span class="text-slate-400 text-[10px] ml-1">${rTime}</span>
                        <div class="text-slate-700">Đã trả: <b>${rh.summaryText}</b> — Hoàn: <b class="text-red-600">${formatmoney(rh.refundAmount)}đ</b> (${rh.reason || 'Trả hàng'})</div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <button type="button" onclick="editPoReturnHistoryEntry('${po.poCode}', ${rIdx})" title="Sửa nội dung phiếu hoàn này" class="px-2 py-1 bg-amber-100 hover:bg-amber-500 text-amber-800 hover:text-white rounded text-[10px] font-bold transition">
                            <i class="fa-solid fa-pen"></i> Sửa
                        </button>
                        <button type="button" onclick="deletePoReturnHistoryEntry('${po.poCode}', ${rIdx})" title="Xóa phiếu hoàn này cho nhẹ dữ liệu" class="px-2 py-1 bg-red-100 hover:bg-red-600 text-red-600 hover:text-white rounded text-[10px] font-bold transition">
                            <i class="fa-solid fa-trash-can"></i> Xóa
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        retBox.classList.add('hidden');
    }

    document.getElementById('pod-total-amount').innerText = `${formatmoney(po.totalAmount || 0)} đ`;
    document.getElementById('pod-paid-amount').innerText = `${formatmoney(po.paidAmount || 0)} đ`;
    document.getElementById('pod-debt-amount').innerText = `${formatmoney(po.debtAmount || 0)} đ`;

    const btnOpenRet = document.getElementById('btn-open-po-return');
    if (btnOpenRet) btnOpenRet.classList.toggle('hidden', items.length === 0);

    switchPoDetailToViewMode();
    document.getElementById('po-detail-modal').classList.remove('hidden');
}

function closePoDetailModal() {
    document.getElementById('po-detail-modal').classList.add('hidden');
}

// 1. SỬA DÒNG LỊCH SỬ PHIẾU HOÀN TRẢ NHÀ CUNG CẤP
async function editPoReturnHistoryEntry(poCode, retIdx) {
    const po = currentViewingPo && currentViewingPo.poCode === poCode
        ? currentViewingPo
        : cachedPurchaseOrders.find(p => p.poCode === poCode);
    if (!po || !Array.isArray(po.returnHistory) || !po.returnHistory[retIdx]) return;

    const entry = po.returnHistory[retIdx];
    const newSummary = prompt("Sửa chi tiết mặt hàng đã hoàn trả:", entry.summaryText || "");
    if (newSummary === null) return;

    const newRefundRaw = prompt("Sửa số tiền Nhà Cung Cấp hoàn lại (VNĐ):", entry.refundAmount || 0);
    if (newRefundRaw === null) return;
    const newRefundAmount = parseInt(newRefundRaw.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;

    const newReason = prompt("Sửa lý do hoàn trả:", entry.reason || "");
    if (newReason === null) return;

    const updatedHistory = [...po.returnHistory];
    updatedHistory[retIdx] = {
        ...entry,
        summaryText: newSummary.trim() || entry.summaryText,
        refundAmount: newRefundAmount,
        reason: newReason.trim()
    };

    try {
        await db.collection("purchase_orders").doc(po.poCode).update({ returnHistory: updatedHistory });
        po.returnHistory = updatedHistory;
        const cIdx = cachedPurchaseOrders.findIndex(x => x.poCode === po.poCode);
        if (cIdx !== -1) cachedPurchaseOrders[cIdx].returnHistory = updatedHistory;

        openPoDetailModal(po.poCode);
        renderPoListScreen(false);
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) openPoHistoryModal();
    } catch (e) {
        alert("Lỗi khi sửa lịch sử hoàn trả: " + e.message);
    }
}

// 2. XÓA DÒNG LỊCH SỬ PHIẾU HOÀN TRẢ NHÀ CUNG CẤP (SAU KHI ĐÃ LÀM MINH CHỨNG XONG)
async function deletePoReturnHistoryEntry(poCode, retIdx) {
    const po = currentViewingPo && currentViewingPo.poCode === poCode
        ? currentViewingPo
        : cachedPurchaseOrders.find(p => p.poCode === poCode);
    if (!po || !Array.isArray(po.returnHistory) || !po.returnHistory[retIdx]) return;

    const entry = po.returnHistory[retIdx];
    if (!confirm(`Bạn muốn XÓA phiếu hoàn trả "${entry.returnCode || ''}" (${entry.summaryText} - ${formatmoney(entry.refundAmount)}đ) khỏi lịch sử cho nhẹ dữ liệu?`)) {
        return;
    }

    const updatedHistory = po.returnHistory.filter((_, idx) => idx !== retIdx);

    try {
        await db.collection("purchase_orders").doc(po.poCode).update({ returnHistory: updatedHistory });

        // Dọn dẹp luôn bản ghi log liên quan của mã phiếu hoàn này (nếu có) cho nhẹ dữ liệu Firestore
        if (entry.returnCode) {
            const [cbSnap, debtSnap] = await Promise.all([
                db.collection("cashbook").where("voucherCode", "==", entry.returnCode).get(),
                db.collection("debts").where("referenceId", "==", entry.returnCode).get()
            ]);
            cbSnap.docs.forEach(d => d.ref.delete());
            debtSnap.docs.forEach(d => d.ref.delete());
        }

        po.returnHistory = updatedHistory;
        const cIdx = cachedPurchaseOrders.findIndex(x => x.poCode === po.poCode);
        if (cIdx !== -1) cachedPurchaseOrders[cIdx].returnHistory = updatedHistory;

        openPoDetailModal(po.poCode);
        renderPoListScreen(false);
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) openPoHistoryModal();
    } catch (e) {
        alert("Lỗi khi xóa phiếu hoàn trả: " + e.message);
    }
}

// 3. SỬA THÔNG TIN PHIẾU NHẬP HÀNG (SỐ HÓA ĐƠN, TIỀN ĐÃ TRẢ, TỔNG TIỀN)
async function editCurrentPoMetadata() {
    if (!currentViewingPo) return;
    const po = currentViewingPo;

    const newInvoiceNo = prompt("Sửa Số hóa đơn gốc của NPP:", po.invoiceNo || po.poCode || "");
    if (newInvoiceNo === null) return;

    const newTotalRaw = prompt("Sửa Tổng tiền hàng của phiếu nhập (VNĐ):", po.totalAmount || 0);
    if (newTotalRaw === null) return;
    const newTotal = parseInt(newTotalRaw.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;

    const newPaidRaw = prompt("Sửa Số tiền ĐÃ THANH TOÁN cho NPP (VNĐ):", po.paidAmount || 0);
    if (newPaidRaw === null) return;
    const newPaid = parseInt(newPaidRaw.toString().replace(/\./g, '').replace(/\D/g, ''), 10) || 0;

    const newDebt = Math.max(0, newTotal - newPaid);
    const updatedFields = {
        invoiceNo: newInvoiceNo.trim() || po.poCode,
        totalAmount: newTotal,
        paidAmount: newPaid,
        debtAmount: newDebt
    };

    try {
        await db.collection("purchase_orders").doc(po.poCode).update(updatedFields);
        Object.assign(po, updatedFields);
        const cIdx = cachedPurchaseOrders.findIndex(x => x.poCode === po.poCode);
        if (cIdx !== -1) Object.assign(cachedPurchaseOrders[cIdx], updatedFields);

        openPoDetailModal(po.poCode);
        renderPoListScreen(false);
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) openPoHistoryModal();
        alert("✅ Đã cập nhật thông tin Phiếu Nhập thành công!");
    } catch (e) {
        alert("Lỗi khi sửa phiếu nhập: " + e.message);
    }
}

// 4. XÓA HẲN PHIẾU NHẬP HÀNG KHỎI LỊCH SỬ (CÓ TÙY CHỌN CHỈ XÓA LỊCH SỬ CHO NHẸ DỮ LIỆU HOẶC TRỪ NGƯỢC KHO)
async function deleteCurrentPurchaseOrder() {
    if (!currentViewingPo) return;
    const po = currentViewingPo;

    const mode = prompt(
        `XÓA PHIẾU NHẬP HÀNG "${po.poCode}" (${po.supplierName}):\n` +
        `Nhập số để chọn cách xóa:\n` +
        `1 - Chỉ xóa lịch sử phiếu nhập cho nhẹ dữ liệu (Giữ nguyên tồn kho & công nợ hiện tại)\n` +
        `2 - Xóa phiếu nhập VÀ trừ ngược lại số lượng tồn kho, công nợ, sổ quỹ đã nhập`,
        "1"
    );

    if (mode !== "1" && mode !== "2") return;

    try {
        if (mode === "2") {
            // Đảo ngược tồn kho của các mặt hàng còn trong phiếu
            for (const item of (po.items || [])) {
                const dbProd = inventory.find(i => i.id === item.productId) ||
                               inventory.find(i => (i.name || '').toLowerCase() === (item.productName || '').toLowerCase());
                if (dbProd) {
                    const rate = Math.max(1, Number(item.conversionRate) || 1);
                    const deductBase = Number(item.baseQty) || ((Number(item.qty) || 0) * rate);
                    const startStock = Number(dbProd.stock) || 0;
                    const endStock = startStock - deductBase;
                    await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                    await writeInventoryLog(
                        dbProd.id, dbProd.name, "ADJUST", `XÓA-${po.poCode}`,
                        `Trừ kho do xóa phiếu nhập ${po.poCode}`, startStock, -deductBase, endStock
                    );
                }
            }

            // Đảo ngược công nợ NPP (nếu có)
            if (po.supplierId && po.supplierId !== 'GENERAL' && (Number(po.debtAmount) || 0) > 0) {
                const sup = (typeof customers !== 'undefined' ? customers : []).find(c => c.id === po.supplierId);
                if (sup) {
                    const newSupDebt = Math.max(0, (Number(sup.currentDebt) || 0) - (Number(po.debtAmount) || 0));
                    await db.collection("customers").doc(sup.id).update({ currentDebt: newSupDebt, updatedAt: Date.now() });
                }
            }

            const [cbSnap, debtSnap] = await Promise.all([
                db.collection("cashbook").where("referenceId", "==", po.poCode).get(),
                db.collection("debts").where("referenceId", "==", po.poCode).get()
            ]);
            cbSnap.docs.forEach(d => d.ref.delete());
            debtSnap.docs.forEach(d => d.ref.delete());
        }

        await db.collection("purchase_orders").doc(po.poCode).delete();
        cachedPurchaseOrders = cachedPurchaseOrders.filter(x => x.poCode !== po.poCode);

        closePoDetailModal();
        renderPoListScreen(false);
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) openPoHistoryModal();
        alert(`✅ Đã xóa phiếu nhập ${po.poCode} thành công!`);
    } catch (e) {
        alert("Lỗi khi xóa phiếu nhập: " + e.message);
    }
}

function switchPoDetailToViewMode() {
    if (!currentViewingPo) return;
    document.getElementById('pod-header-title').innerHTML = `<i class="fa-solid fa-file-invoice"></i> Chi Tiết Phiếu Nhập: ${currentViewingPo.poCode}`;
    document.getElementById('pod-header-subtitle').innerText = `Nhà cung cấp: ${currentViewingPo.supplierName || 'Nhà cung cấp lẻ'}`;
    document.getElementById('pod-view-section').classList.remove('hidden');
    document.getElementById('pod-view-footer').classList.remove('hidden');
    document.getElementById('pod-return-section').classList.add('hidden');
    document.getElementById('pod-return-footer').classList.add('hidden');
}

// Chuyển sang giao diện Hoàn Trả Nhà Cung Cấp (có nút [-] [+] chọn số lượng trả)
function switchPoDetailToReturnMode() {
    if (!currentViewingPo) return;
    const items = Array.isArray(currentViewingPo.items) ? currentViewingPo.items : [];
    if (items.length === 0) return alert("Phiếu nhập này không còn mặt hàng nào để hoàn trả!");

    document.getElementById('pod-header-title').innerHTML = `<i class="fa-solid fa-rotate-left text-amber-300"></i> Hoàn Trả Nhà Cung Cấp (${currentViewingPo.poCode})`;
    document.getElementById('pod-header-subtitle').innerText = `Chọn số lượng hàng lỗi / cận date muốn xuất trả lại cho ${currentViewingPo.supplierName || 'NPP'}`;

    const refundModeSel = document.getElementById('pod-ret-refund-mode');
    if (refundModeSel) {
        if ((Number(currentViewingPo.debtAmount) || 0) > 0) {
            refundModeSel.value = 'DEBT_OFFSET';
        } else if (currentViewingPo.paymentMethod === 'BANK') {
            refundModeSel.value = 'BANK_REFUND';
        } else {
            refundModeSel.value = 'CASH_REFUND';
        }
    }

    const listEl = document.getElementById('pod-return-items-list');
    listEl.innerHTML = items.map((item, idx) => {
        const rate = Math.max(1, Number(item.conversionRate) || 1);
        const bUnit = item.baseUnit || item.unitName || 'Cái';
        const maxQty = Number(item.qty) || 0;

        return `
            <div class="p-3 rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div class="flex-1 min-w-0">
                    <div class="font-bold text-slate-800 text-xs sm:text-sm truncate">${item.productName}</div>
                    <div class="text-[11px] text-slate-500 mt-0.5">
                        Giá nhập: <b class="text-emerald-700">${formatmoney(item.importPrice)}đ/${item.unitName}</b>
                        • Đã nhập: <b class="text-slate-800">${maxQty} ${item.unitName}</b>
                        ${rate > 1 ? `<span class="text-slate-400">(1 ${item.unitName} = ${rate}${bUnit})</span>` : ''}
                    </div>
                </div>

                <div class="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
                    <!-- Cụm nút [-] [Số lượng] [+] -->
                    <div class="flex items-center gap-1">
                        <button type="button" onclick="changePoReturnQty(${idx}, -1)" class="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 font-black flex items-center justify-center border border-slate-300">
                            <i class="fa-solid fa-minus text-xs"></i>
                        </button>
                        <input type="number" id="pod-ret-qty-${idx}" data-idx="${idx}" min="0" max="${maxQty}" value="0"
                            oninput="changePoReturnQty(${idx}, 0, this.value)"
                            class="pod-ret-qty-inp w-14 h-8 border-2 border-amber-400 rounded-lg text-center font-black text-sm text-red-600 bg-white focus:outline-none">
                        <button type="button" onclick="changePoReturnQty(${idx}, 1)" class="w-8 h-8 rounded-lg bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white font-black flex items-center justify-center shadow-sm">
                            <i class="fa-solid fa-plus text-xs"></i>
                        </button>
                    </div>

                    <div class="text-right min-w-[105px]">
                        <div class="font-black text-red-600 text-xs sm:text-sm" id="pod-ret-line-money-${idx}">0 đ</div>
                        <div class="text-[10px] text-slate-400 font-semibold" id="pod-ret-line-stock-${idx}">Trừ kho: 0 ${bUnit}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    calcPoReturnTotal();
    document.getElementById('pod-view-section').classList.add('hidden');
    document.getElementById('pod-view-footer').classList.add('hidden');
    document.getElementById('pod-return-section').classList.remove('hidden');
    document.getElementById('pod-return-footer').classList.remove('hidden');
}

function changePoReturnQty(idx, delta, exactVal = null) {
    if (!currentViewingPo || !currentViewingPo.items[idx]) return;
    const item = currentViewingPo.items[idx];
    const maxQty = Number(item.qty) || 0;
    const inp = document.getElementById(`pod-ret-qty-${idx}`);
    if (!inp) return;

    let newQty = exactVal !== null ? (parseInt(exactVal, 10) || 0) : ((parseInt(inp.value, 10) || 0) + delta);
    if (newQty < 0) newQty = 0;
    if (newQty > maxQty) newQty = maxQty;

    inp.value = newQty;
    calcPoReturnTotal();
}

function calcPoReturnTotal() {
    if (!currentViewingPo) return 0;
    let totalRefund = 0;
    const stockDeductParts = [];

    (currentViewingPo.items || []).forEach((item, idx) => {
        const inp = document.getElementById(`pod-ret-qty-${idx}`);
        let rQty = inp ? (parseInt(inp.value, 10) || 0) : 0;
        const maxQty = Number(item.qty) || 0;
        if (rQty > maxQty) { rQty = maxQty; if (inp) inp.value = rQty; }
        if (rQty < 0) { rQty = 0; if (inp) inp.value = 0; }

        const rate = Math.max(1, Number(item.conversionRate) || 1);
        const bUnit = item.baseUnit || item.unitName || 'Cái';
        const baseDeduct = rQty * rate;
        const lineMoney = rQty * (Number(item.importPrice) || 0);

        totalRefund += lineMoney;
        if (rQty > 0) {
            stockDeductParts.push(`-${baseDeduct} ${bUnit} (${item.productName})`);
        }

        const moneyEl = document.getElementById(`pod-ret-line-money-${idx}`);
        if (moneyEl) moneyEl.innerText = `${formatmoney(lineMoney)} đ`;
        const stockEl = document.getElementById(`pod-ret-line-stock-${idx}`);
        if (stockEl) {
            stockEl.innerText = `Trừ kho: -${baseDeduct} ${bUnit}`;
            stockEl.className = rQty > 0 ? "text-[10px] text-red-600 font-bold" : "text-[10px] text-slate-400 font-semibold";
        }
    });

    const totalEl = document.getElementById('pod-ret-total-refund');
    if (totalEl) totalEl.innerText = `${formatmoney(totalRefund)} đ`;

    const sumStockEl = document.getElementById('pod-ret-stock-summary');
    if (sumStockEl) {
        sumStockEl.innerText = stockDeductParts.length > 0
            ? `Tự động trừ kho: ${stockDeductParts.join(', ')}`
            : `Chưa chọn mặt hàng nào để trả`;
    }

    return totalRefund;
}

// Xác nhận Hoàn Trả Nhà Cung Cấp: Tự động tính tiền hoàn, Tự động TRỪ TỒN KHO, cập nhật Phiếu Nhập & Công nợ NPP
async function submitPoReturnToSupplier() {
    if (!currentViewingPo) return;
    const po = currentViewingPo;
    const items = Array.isArray(po.items) ? po.items : [];

    const returnedItems = [];
    const remainingItems = [];
    let totalRefundAmount = 0;

    items.forEach((origItem, idx) => {
        const inp = document.getElementById(`pod-ret-qty-${idx}`);
        const rQty = inp ? Math.max(0, Math.min(Number(origItem.qty) || 0, parseInt(inp.value, 10) || 0)) : 0;
        const rate = Math.max(1, Number(origItem.conversionRate) || 1);
        const bUnit = origItem.baseUnit || origItem.unitName || 'Cái';

        if (rQty > 0) {
            const baseQtyDeduct = rQty * rate;
            const lineRefund = rQty * (Number(origItem.importPrice) || 0);
            totalRefundAmount += lineRefund;
            returnedItems.push({
                ...origItem,
                returnQty: rQty,
                baseQtyDeduct: baseQtyDeduct,
                baseUnit: bUnit,
                lineRefund: lineRefund
            });
        }

        const leftQty = (Number(origItem.qty) || 0) - rQty;
        if (leftQty > 0) {
            remainingItems.push({
                ...origItem,
                qty: leftQty,
                baseQty: leftQty * rate,
                totalCost: leftQty * (Number(origItem.importPrice) || 0),
                returnedQty: (Number(origItem.returnedQty) || 0) + rQty
            });
        }
    });

    if (returnedItems.length === 0) {
        return alert("Vui lòng bấm nút [+] chọn số lượng hoàn trả lớn hơn 0 ở ít nhất 1 mặt hàng!");
    }

    const refundMode = document.getElementById('pod-ret-refund-mode')?.value || 'DEBT_OFFSET';
    const reason = (document.getElementById('pod-ret-reason')?.value || '').trim() || "Hoàn trả hàng lỗi / cận date cho NPP";

    const summaryParts = returnedItems.map(r => `${r.productName} (${r.returnQty} ${r.unitName} = -${r.baseQtyDeduct} ${r.baseUnit})`);
    if (!confirm(
        `XÁC NHẬN HOÀN TRẢ NHÀ CUNG CẤP:\n` +
        `- Phiếu nhập gốc: ${po.poCode} (${po.supplierName})\n` +
        `- Hàng xuất trả: ${summaryParts.join(', ')}\n` +
        `- Tổng tiền hoàn lại: ${formatmoney(totalRefundAmount)} đ\n\n` +
        `Hệ thống sẽ tự động TRỪ TỒN KHO của các mặt hàng trên. Bạn có chắc chắn muốn thực hiện?`
    )) return;

    const btn = document.getElementById('btn-submit-po-return');
    const origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang trừ kho & hoàn trả...`;
    }

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const retVoucherCode = `THN-${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        // 1. TỰ ĐỘNG TRỪ TỒN KHO CỦA CÁC MẶT HÀNG HOÀN TRẢ & GHI THẺ KHO
        for (const rItem of returnedItems) {
            const dbProd = inventory.find(i => i.id === rItem.productId) ||
                           inventory.find(i => (i.name || '').toLowerCase() === (rItem.productName || '').toLowerCase());
            if (dbProd) {
                const startStock = Number(dbProd.stock) || 0;
                const endStock = startStock - rItem.baseQtyDeduct;
                await db.collection("inventory").doc(dbProd.id).update({ stock: endStock });
                await writeInventoryLog(
                    dbProd.id,
                    dbProd.name,
                    "ADJUST",
                    `${retVoucherCode} (Hoàn NPP ${po.poCode})`,
                    `Trả lại NPP: -${rItem.returnQty} ${rItem.unitName} (-${rItem.baseQtyDeduct} ${rItem.baseUnit})`,
                    startStock,
                    -rItem.baseQtyDeduct,
                    endStock
                );
            }
        }

        // 2. XỬ LÝ TIỀN HOÀN LẠI (TRỪ CÔNG NỢ NHÀ CUNG CẤP HOẶC THU TIỀN VÀO SỔ QUỸ)
        const supObj = (typeof customers !== 'undefined' ? customers : []).find(c => c.id === po.supplierId);
        const curPoDebt = Number(po.debtAmount) || 0;
        let debtReducedOnPo = 0;
        let cashRefunded = 0;
        let refundChannel = refundMode === 'BANK_REFUND' ? 'BANK' : 'CASH';

        if (refundMode === 'DEBT_OFFSET') {
            debtReducedOnPo = Math.min(curPoDebt, totalRefundAmount);
            cashRefunded = totalRefundAmount - debtReducedOnPo;

            if (supObj && (Number(supObj.currentDebt) || 0) > 0) {
                const oldSupDebt = Number(supObj.currentDebt) || 0;
                const offsetSup = Math.min(oldSupDebt, totalRefundAmount);
                const afterSupDebt = Math.max(0, oldSupDebt - offsetSup);
                await db.collection("customers").doc(supObj.id).update({ currentDebt: afterSupDebt, updatedAt: Date.now() });
                await db.collection("debts").add({
                    customerId: supObj.id,
                    customerName: supObj.name,
                    ledgerType: "PAYABLE",
                    transactionType: "RETURN_OFFSET",
                    referenceId: retVoucherCode,
                    beforeDebt: oldSupDebt,
                    changeAmount: -offsetSup,
                    afterDebt: afterSupDebt,
                    note: `Trừ nợ Phải trả NPP do hoàn hàng phiếu ${po.poCode} (${reason})`,
                    createdAt: Date.now()
                });
            }
        } else {
            cashRefunded = totalRefundAmount;
        }

        if (cashRefunded > 0) {
            await db.collection("cashbook").add({
                voucherCode: retVoucherCode,
                type: "INCOME",
                channel: refundChannel,
                category: "IMPORT_REFUND",
                amount: cashRefunded,
                referenceId: po.poCode,
                note: `Thu tiền Nhà cung cấp (${po.supplierName}) hoàn trả hàng phiếu ${po.poCode} (${reason})`,
                seller: document.getElementById('seller-name')?.value || "Chủ Quán",
                dateStr,
                createdAt: Date.now()
            });
        }

        // 3. CẬP NHẬT LẠI PHIẾU NHẬP TRÊN FIRESTORE & BỘ NHỚ TẠM
        const newTotalAmount = Math.max(0, (Number(po.totalAmount) || 0) - totalRefundAmount);
        const newDebtAmount = Math.max(0, curPoDebt - debtReducedOnPo);
        const newPaidAmount = Math.max(0, (Number(po.paidAmount) || 0) - cashRefunded);
        const updatedHistory = [
            ...(Array.isArray(po.returnHistory) ? po.returnHistory : []),
            {
                returnCode: retVoucherCode,
                returnedAt: Date.now(),
                refundAmount: totalRefundAmount,
                reason: reason,
                summaryText: returnedItems.map(r => `${r.productName} (x${r.returnQty} ${r.unitName})`).join(', ')
            }
        ];

        const updatedPoFields = {
            items: remainingItems,
            totalAmount: newTotalAmount,
            paidAmount: newPaidAmount,
            debtAmount: newDebtAmount,
            returnHistory: updatedHistory
        };

        await db.collection("purchase_orders").doc(po.poCode).update(updatedPoFields);

        // Cập nhật ngay vào bộ nhớ tạm để UI làm mới tức thì không bị lag
        Object.assign(po, updatedPoFields);
        const cacheIdx = cachedPurchaseOrders.findIndex(x => x.poCode === po.poCode);
        if (cacheIdx !== -1) {
            cachedPurchaseOrders[cacheIdx] = { ...po };
        }

        renderPoListScreen(false);
        const histModal = document.getElementById('po-history-modal');
        if (histModal && !histModal.classList.contains('hidden')) {
            openPoHistoryModal();
        }

        openPoDetailModal(po.poCode);
        alert(
            `✅ Đã hoàn trả Nhà Cung Cấp thành công (${retVoucherCode})!\n` +
            `- Đã tự động TRỪ TỒN KHO: ${summaryParts.join(', ')}\n` +
            `- Tổng tiền hoàn lại: ${formatmoney(totalRefundAmount)} đ`
        );
    } catch (e) {
        alert("Lỗi khi hoàn trả nhà cung cấp: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origBtnHtml;
        }
    }
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