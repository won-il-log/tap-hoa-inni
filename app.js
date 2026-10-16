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

let storeSettings = JSON.parse(localStorage.getItem('hh_store_settings')) || {
    storeName: "Tạp Hóa Huy Hoàng",
    phone: "0909.xxx.xxx",
    address: "Đồng Nai",
    printSize: "A5",
    bankId: "MB",
    bankAcc: "",
    bankOwner: ""
};

// ==========================================
// 2. HÀM TIỆN ÍCH DÙNG CHUNG & CAMERA BARCODE SCANNER
// ==========================================
window.addEventListener('load', () => {
    initCategorySelects();
    applyStoreSettingsToUI();
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.classList.add('splash-fade-out');
            setTimeout(() => splash.remove(), 400);
        }
    }, 1000);
});

// Phát tiếng Bíp khi quét mã vạch thành công
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

// Mở Camera quét mã vạch điền thẳng vào ô Input hoặc gọi hàm xử lý
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
// 3. LẮNG NGHE DỮ LIỆU KHO HÀNG
// ==========================================
db.collection("inventory").onSnapshot((snapshot) => {
    inventory = snapshot.docs.map(doc => {
        const d = doc.data();
        const basePrice = Number(d.basePrice ?? d.price ?? 0);
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
            price: basePrice,
            costPrice: Number(d.costPrice ?? Math.round(basePrice * 0.85)),
            stock: Number(d.stock ?? 0),
            minStock: Number(d.minStock ?? 10),
            units: Array.isArray(d.units) && d.units.length > 0 ? d.units : [
                { unitName: baseUnit, conversionRate: 1, sellingPrice: basePrice, barcode: d.barcode || "" }
            ],
            createdAt: d.createdAt || 0
        };
    });
    inventory.sort((a, b) => b.createdAt - a.createdAt);
    renderInventory();
    if (typeof renderSellGrid === 'function') renderSellGrid();
});

// ==========================================
// 4. MODULE 5: HIỂN THỊ KHO TÁCH 2 CỘT GIÁ BÁN LẺ & GIÁ BÁN SỈ
// ==========================================
function formatStockMultiUnit(item) {
    const stock = item.stock;
    if (stock <= 0) return `<span class="text-red-600 font-black">Hết hàng (${stock})</span>`;
    
    const largeUnits = item.units.filter(u => u.conversionRate > 1).sort((a, b) => b.conversionRate - a.conversionRate);
    if (largeUnits.length > 0) {
        const topUnit = largeUnits[0];
        const major = Math.floor(stock / topUnit.conversionRate);
        const rem = stock % topUnit.conversionRate;
        if (major > 0) {
            return `<div class="font-black text-slate-800">${stock} ${item.baseUnit}</div>
                    <div class="text-[11px] text-emerald-700 font-semibold">(= ${major} ${topUnit.unitName}${rem > 0 ? ` lẻ ${rem}${item.baseUnit}` : ''})</div>`;
        }
    }
    return `<span class="font-black text-slate-800">${stock} ${item.baseUnit}</span>`;
}

function toggleLowStockFilter() {
    const sel = document.getElementById('inv-filter-stock');
    sel.value = sel.value === 'low' ? 'all' : 'low';
    renderInventory();
}

function renderInventory() {
    const tbody = document.getElementById('inventory-list');
    const noRes = document.getElementById('inv-no-result');
    if (!tbody) return;
    tbody.innerHTML = '';

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

        const imgTag = item.image 
            ? `<img src="${item.image}" class="w-11 h-11 object-contain rounded-lg border bg-white p-0.5">`
            : `<div class="w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400"><i class="fa-solid fa-image"></i></div>`;

        // TÁCH CỘT 1: GIÁ BÁN LẺ (Đơn vị nhỏ)
        const retailHtml = `<div class="font-black text-red-600 text-base">${formatmoney(item.basePrice)} đ</div>
                            <div class="text-[11px] text-slate-500 font-semibold">/ 1 ${item.baseUnit}</div>`;

        // TÁCH CỘT 2: GIÁ BÁN SỈ (Các đơn vị quy đổi lớn: Thùng, Lốc...)
        const wholesaleUnits = item.units.filter(u => u.conversionRate > 1);
        const wholesaleHtml = wholesaleUnits.length > 0
            ? wholesaleUnits.map(u => `
                <div class="mb-1 last:mb-0 bg-blue-50/80 border border-blue-200 px-2.5 py-1 rounded-lg flex items-center justify-between gap-2">
                    <span class="text-xs font-bold text-slate-700">1 ${u.unitName} <span class="text-[10px] text-slate-500 font-normal">(${u.conversionRate} ${item.baseUnit})</span></span>
                    <span class="font-black text-inni-blue text-sm whitespace-nowrap">${formatmoney(u.sellingPrice)} đ</span>
                </div>
            `).join('')
            : `<span class="text-xs text-slate-400 italic">Chưa cài đặt ĐV sỉ</span>`;

        const rowBg = isLow ? "bg-red-50/70 hover:bg-red-100/60" : "hover:bg-blue-50/40";
        const lowBadge = isLow 
            ? `<span class="ml-1.5 px-1.5 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded animate-pulse"><i class="fa-solid fa-triangle-exclamation"></i> Cảnh báo tồn (<=${item.minStock})</span>` 
            : '';

        const tr = document.createElement('tr');
        tr.className = `transition ${rowBg}`;
        tr.innerHTML = `
            <td class="p-3">${imgTag}</td>
            <td class="p-3">
                <div class="font-bold text-slate-800 flex items-center flex-wrap">${item.name} ${lowBadge}</div>
                <div class="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span class="bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-semibold">${item.category}</span>
                    ${item.barcode ? `<span><i class="fa-solid fa-barcode"></i> ${item.barcode}</span>` : ''}
                    ${item.keywords.length ? `<span class="text-blue-600 italic">Zalo: ${item.keywords.join(', ')}</span>` : ''}
                </div>
            </td>
            <td class="p-3 text-right font-semibold text-slate-600">${formatmoney(item.costPrice)} đ<span class="text-[10px] text-slate-400 block">/${item.baseUnit}</span></td>
            <td class="p-3 text-right bg-red-50/20">${retailHtml}</td>
            <td class="p-3 bg-blue-50/20">${wholesaleHtml}</td>
            <td class="p-3 text-center">${formatStockMultiUnit(item)}</td>
            <td class="p-3 text-center">
                <div class="flex justify-center gap-1.5">
                    <button onclick="openStockCardModal('${item.id}')" title="Xem, Sửa & Xóa Thẻ Kho" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-amber-300 rounded-lg text-xs font-bold flex items-center gap-1 shadow-sm scale-active">
                        <i class="fa-solid fa-clipboard-list"></i> Thẻ Kho
                    </button>
                    <button onclick="openProductModal('${item.id}')" title="Sửa mặt hàng" class="w-8 h-8 bg-amber-50 hover:bg-amber-500 text-amber-600 hover:text-white rounded-lg flex items-center justify-center transition scale-active border border-amber-200">
                        <i class="fa-solid fa-pen text-xs"></i>
                    </button>
                    <button onclick="deleteProduct('${item.id}')" title="Xóa mặt hàng" class="w-8 h-8 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-lg flex items-center justify-center transition scale-active border border-red-200">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('inv-stat-total').innerText = `${totalItems} mặt hàng`;
    document.getElementById('inv-stat-capital').innerText = `${formatmoney(totalCapital)} đ`;
    document.getElementById('inv-stat-low').innerText = `${lowStockCount} món`;
    document.getElementById('inv-stat-retail').innerText = `${formatmoney(totalRetail)} đ`;

    const badgeDesk = document.getElementById('badge-low-stock');
    const badgeMob = document.getElementById('badge-mobile-low-stock');
    if (lowStockCount > 0) {
        badgeDesk.innerText = lowStockCount;
        badgeDesk.classList.remove('hidden');
        badgeMob.classList.remove('hidden');
    } else {
        badgeDesk.classList.add('hidden');
        badgeMob.classList.add('hidden');
    }

    if (renderedCount === 0) noRes.classList.remove('hidden');
    else noRes.classList.add('hidden');
}

// --- THÊM / SỬA MẶT HÀNG ĐA ĐƠN VỊ (CÓ NÚT QUÉT MÃ VẠCH CHO ĐƠN VỊ SỈ) ---
function addUnitRow(unitName = '', conversionRate = '', sellingPrice = '', barcode = '') {
    const container = document.getElementById('unit-rows-container');
    const div = document.createElement('div');
    div.className = "grid grid-cols-12 gap-2 items-center unit-row bg-white p-2 rounded-lg border border-blue-200 shadow-sm";
    div.innerHTML = `
        <div class="col-span-3">
            <input type="text" placeholder="Thùng, Lốc..." value="${unitName}" class="unit-name w-full border border-slate-300 p-1.5 rounded text-xs font-bold text-slate-800">
        </div>
        <div class="col-span-3">
            <input type="number" placeholder="VD: 24" value="${conversionRate}" class="unit-rate w-full border border-slate-300 p-1.5 rounded text-xs text-center font-bold text-emerald-700">
        </div>
        <div class="col-span-3">
            <input type="text" oninput="formatCurrencyInput(this)" placeholder="VD: 340.000" value="${sellingPrice ? formatmoney(sellingPrice) : ''}" class="unit-price w-full border-2 border-blue-400 p-1.5 rounded text-xs font-black text-inni-blue">
        </div>
        <div class="col-span-2 flex gap-1">
            <input type="text" placeholder="Mã vạch" value="${barcode}" class="unit-barcode w-full border border-slate-300 p-1.5 rounded text-xs">
            <button type="button" onclick="startBarcodeScanner(this.previousElementSibling)" title="Quét mã vạch thùng" class="bg-slate-800 text-amber-400 px-2 rounded text-xs"><i class="fa-solid fa-camera"></i></button>
        </div>
        <div class="col-span-1 text-center">
            <button type="button" onclick="this.closest('.unit-row').remove()" class="text-red-400 hover:text-red-600"><i class="fa-solid fa-trash-can"></i></button>
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
        document.getElementById('prod-stock').value = '0';
        document.getElementById('prod-min-stock').value = '24';
        addUnitRow('Thùng', 24, '');
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
        document.getElementById('prod-stock').value = item.stock;
        document.getElementById('prod-min-stock').value = item.minStock;

        const wholesaleUnits = item.units.filter(u => u.conversionRate > 1);
        if (wholesaleUnits.length > 0) {
            wholesaleUnits.forEach(u => addUnitRow(u.unitName, u.conversionRate, u.sellingPrice, u.barcode || ''));
        } else {
            addUnitRow('Thùng', 24, '');
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
    const stock = parseInt(document.getElementById('prod-stock').value, 10) || 0;
    const minStock = parseInt(document.getElementById('prod-min-stock').value, 10) || 0;
    const imageInput = document.getElementById('prod-image');

    if (!name || basePrice <= 0) {
        return alert("Vui lòng nhập Tên sản phẩm và Giá bán lẻ hợp lệ!");
    }

    const keywords = keywordsRaw.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    const units = [{ unitName: baseUnit, conversionRate: 1, sellingPrice: basePrice, barcode: barcode }];

    document.querySelectorAll('#unit-rows-container .unit-row').forEach(row => {
        const uName = row.querySelector('.unit-name').value.trim();
        const uRate = parseInt(row.querySelector('.unit-rate').value, 10) || 0;
        const uPrice = getRawNum(row.querySelector('.unit-price'));
        const uBarcode = row.querySelector('.unit-barcode').value.trim();
        if (uName && uRate > 1 && uPrice > 0) {
            units.push({ unitName: uName, conversionRate: uRate, sellingPrice: uPrice, barcode: uBarcode });
        }
    });

    const btn = document.getElementById('btn-save-product');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;

    const productData = {
        name, category, keywords, barcode, baseUnit,
        costPrice: costPrice > 0 ? costPrice : Math.round(basePrice * 0.85),
        basePrice, price: basePrice,
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
// 5. THẺ KHO (STOCK CARD) - CÓ SỬA & XÓA LỊCH SỬ THẺ KHO
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
    document.getElementById('sc-prod-summary').innerText = `Tồn hiện tại: ${item.stock} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
    document.getElementById('sc-base-unit-label').innerText = item.baseUnit;
    document.getElementById('sc-actual-stock').value = item.stock;
    document.getElementById('sc-adjust-note').value = '';
    document.getElementById('stock-card-modal').classList.remove('hidden');

    loadStockCardLogs(productId, item.baseUnit);
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
            else badge = `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold text-[10px]">KIỂM KÊ</span>`;

            const changeColor = log.changeQty >= 0 ? 'text-emerald-600 font-black' : 'text-red-600 font-black';
            const sign = log.changeQty > 0 ? '+' : '';
            const safeRef = (log.referenceId || '').replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 text-slate-500 whitespace-nowrap">${dStr}</td>
                    <td class="p-2.5">${badge} <span class="font-semibold text-slate-700 ml-1">${log.referenceId || ''}</span></td>
                    <td class="p-2.5 text-slate-600">${log.unitDisplay || ''}</td>
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

// Sửa ghi chú dòng Thẻ Kho
async function editStockLog(logId, currentRef) {
    const newRef = prompt("Nhập nội dung / ghi chú mới cho dòng Thẻ kho này:", currentRef);
    if (newRef === null) return;
    await db.collection("inventory_logs").doc(logId).update({ referenceId: newRef.trim() });
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (item) loadStockCardLogs(item.id, item.baseUnit);
}

// Xóa 1 dòng Thẻ Kho (Có hỏi hoàn trả tồn kho hay không)
async function deleteStockLog(logId, changeQty) {
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return;

    const revertChoice = confirm(
        `Bạn muốn xóa dòng lịch sử Thẻ kho này?\n\n` +
        `Bấm [OK] để XÓA dòng này. (Bước tiếp theo sẽ hỏi bạn có muốn hoàn lại ${Math.abs(changeQty)} ${item.baseUnit} vào tồn kho hay không).`
    );
    if (!revertChoice) return;

    const shouldRevertStock = confirm(
        `Bạn có muốn ĐẢO NGƯỢC số lượng (${changeQty > 0 ? '-' : '+'}${Math.abs(changeQty)} ${item.baseUnit}) vào Tồn kho hiện tại không?\n\n` +
        `- Bấm [OK]: Vừa xóa dòng lịch sử, vừa cộng/trừ trả lại số tồn kho.\n` +
        `- Bấm [Cancel / Hủy]: Chỉ xóa dòng chữ lịch sử, GIỮ NGUYÊN tồn kho hiện tại.`
    );

    if (shouldRevertStock && changeQty !== 0) {
        const newStock = item.stock - changeQty;
        await db.collection("inventory").doc(item.id).update({ stock: newStock });
        document.getElementById('sc-prod-summary').innerText = `Tồn hiện tại: ${newStock} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
        document.getElementById('sc-actual-stock').value = newStock;
    }

    await db.collection("inventory_logs").doc(logId).delete();
    loadStockCardLogs(item.id, item.baseUnit);
}

// Xóa sạch toàn bộ lịch sử Thẻ kho của mặt hàng đang xem
async function clearAllProductLogs() {
    if (!currentViewingProductId) return;
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!confirm(`Xóa sạch toàn bộ lịch sử Thẻ kho của "${item ? item.name : ''}"?\n(Số lượng tồn kho hiện tại vẫn được giữ nguyên).`)) return;

    const snap = await db.collection("inventory_logs").where("productId", "==", currentViewingProductId).get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (item) loadStockCardLogs(item.id, item.baseUnit);
}

function closeStockCardModal() {
    document.getElementById('stock-card-modal').classList.add('hidden');
}

async function submitStockAdjust() {
    if (!currentViewingProductId) return;
    const item = inventory.find(i => i.id === currentViewingProductId);
    if (!item) return;

    const actual = parseInt(document.getElementById('sc-actual-stock').value, 10);
    const note = document.getElementById('sc-adjust-note').value.trim() || "Kiểm kho thực tế";
    if (isNaN(actual) || actual < 0) return alert("Số lượng tồn thực tế không hợp lệ!");

    const diff = actual - item.stock;
    if (diff === 0) return alert("Số lượng thực tế đang bằng đúng tồn kho hiện tại!");

    await db.collection("inventory").doc(item.id).update({ stock: actual });
    await writeInventoryLog(item.id, item.name, "ADJUST", note, `Lệch ${diff > 0 ? '+' : ''}${diff} ${item.baseUnit}`, item.stock, diff, actual);
    
    document.getElementById('sc-prod-summary').innerText = `Tồn hiện tại: ${actual} ${item.baseUnit} • Giá vốn: ${formatmoney(item.costPrice)}đ/${item.baseUnit}`;
    loadStockCardLogs(item.id, item.baseUnit);
    alert("Đã cập nhật tồn kho và ghi vào Thẻ Kho!");
}

// ==========================================
// 6. PHIẾU NHẬP HÀNG TỪ NHÀ CUNG CẤP (SAPO MAC COSTING)
// ==========================================
function openPurchaseOrderModal() {
    if (inventory.length === 0) return alert("Kho chưa có mặt hàng nào. Hãy thêm mặt hàng trước!");
    const prodSel = document.getElementById('po-product-id');
    prodSel.innerHTML = inventory.map(i => `<option value="${i.id}">${i.name} (Tồn: ${i.stock} ${i.baseUnit})</option>`).join('');
    onChangePoProduct();
    document.getElementById('po-modal').classList.remove('hidden');
}

function closePurchaseOrderModal() {
    document.getElementById('po-modal').classList.add('hidden');
}

function onChangePoProduct() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    if (!item) return;

    const unitSel = document.getElementById('po-unit-select');
    unitSel.innerHTML = item.units.map((u, idx) => `<option value="${idx}">${u.unitName} (Quy đổi: ${u.conversionRate} ${item.baseUnit})</option>`).join('');
    
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
    calcPoSummary();
}

function calcPoSummary() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    const uIdx = parseInt(document.getElementById('po-unit-select').value, 10) || 0;
    if (!item || !item.units[uIdx]) return;

    const u = item.units[uIdx];
    const qty = parseInt(document.getElementById('po-qty').value, 10) || 0;
    const importPricePerUnit = getRawNum('po-import-price');

    const addedBaseQty = qty * u.conversionRate;
    const totalImportCost = qty * importPricePerUnit;
    
    const currentStock = Math.max(0, item.stock);
    const oldTotalCost = currentStock * item.costPrice;
    const newMacCost = (currentStock + addedBaseQty) > 0 
        ? Math.round((oldTotalCost + totalImportCost) / (currentStock + addedBaseQty)) 
        : item.costPrice;

    document.getElementById('po-conv-preview').innerText = `+${addedBaseQty} ${item.baseUnit} (${qty} ${u.unitName})`;
    document.getElementById('po-total-preview').innerText = `${formatmoney(totalImportCost)} đ`;
    document.getElementById('po-mac-preview').innerText = `${formatmoney(newMacCost)} đ / ${item.baseUnit}`;
}

async function submitPurchaseOrder() {
    const prodId = document.getElementById('po-product-id').value;
    const item = inventory.find(i => i.id === prodId);
    const uIdx = parseInt(document.getElementById('po-unit-select').value, 10) || 0;
    const qty = parseInt(document.getElementById('po-qty').value, 10) || 0;
    const importPricePerUnit = getRawNum('po-import-price');
    const supplier = document.getElementById('po-supplier').value.trim() || "Nhập hàng NCC";

    if (!item || qty <= 0 || importPricePerUnit <= 0) return alert("Vui lòng nhập số lượng và giá nhập hợp lệ!");

    const u = item.units[uIdx];
    const addedBaseQty = qty * u.conversionRate;
    const totalImportCost = qty * importPricePerUnit;

    const currentStock = Math.max(0, item.stock);
    const newMacCost = Math.round(((currentStock * item.costPrice) + totalImportCost) / (currentStock + addedBaseQty));
    const newStock = item.stock + addedBaseQty;

    const btn = document.getElementById('btn-submit-po');
    btn.disabled = true;
    btn.innerText = "Đang nhập kho...";

    try {
        const poCode = "PN-" + Math.floor(1000 + Math.random() * 9000);
        await db.collection("inventory").doc(item.id).update({
            stock: newStock,
            costPrice: newMacCost
        });
        await writeInventoryLog(
            item.id, item.name, "IMPORT", `${poCode} (${supplier})`,
            `+${qty} ${u.unitName} (${addedBaseQty} ${item.baseUnit})`,
            item.stock, addedBaseQty, newStock
        );
        closePurchaseOrderModal();
        alert(`Đã nhập kho thành công +${qty} ${u.unitName} ${item.name}!\nGiá vốn bình quân mới: ${formatmoney(newMacCost)}đ/${item.baseUnit}`);
    } catch (e) {
        alert("Lỗi nhập kho: " + e.message);
    }

    btn.disabled = false;
    btn.innerText = "Xác Nhận Nhập Kho";
}

// ==========================================
// 7. CÀI ĐẶT CỬA HÀNG, KHỔ IN & VIETQR
// ==========================================
function applyStoreSettingsToUI() {
    document.getElementById('sidebar-store-name').innerText = storeSettings.storeName || "Tạp Hóa Huy Hoàng";
    document.body.classList.remove('print-mode-A5', 'print-mode-80mm');
    document.body.classList.add('print-mode-' + (storeSettings.printSize || 'A5'));
}

function openSettingsModal() {
    document.getElementById('set-store-name').value = storeSettings.storeName;
    document.getElementById('set-store-phone').value = storeSettings.phone;
    document.getElementById('set-store-address').value = storeSettings.address;
    document.getElementById('set-print-size').value = storeSettings.printSize || 'A5';
    document.getElementById('set-bank-id').value = storeSettings.bankId || 'MB';
    document.getElementById('set-bank-acc').value = storeSettings.bankAcc || '';
    document.getElementById('set-bank-owner').value = storeSettings.bankOwner || '';
    document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.add('hidden');
}

function saveStoreSettings() {
    storeSettings = {
        storeName: document.getElementById('set-store-name').value.trim() || "Tạp Hóa Huy Hoàng",
        phone: document.getElementById('set-store-phone').value.trim(),
        address: document.getElementById('set-store-address').value.trim(),
        printSize: document.getElementById('set-print-size').value,
        bankId: document.getElementById('set-bank-id').value,
        bankAcc: document.getElementById('set-bank-acc').value.trim(),
        bankOwner: document.getElementById('set-bank-owner').value.trim().toUpperCase()
    };
    localStorage.setItem('hh_store_settings', JSON.stringify(storeSettings));
    db.collection("shop_data").doc("settings").set(storeSettings).catch(() => {});
    applyStoreSettingsToUI();
    closeSettingsModal();
    alert("Đã lưu cấu hình Cửa hàng & VietQR!");
}