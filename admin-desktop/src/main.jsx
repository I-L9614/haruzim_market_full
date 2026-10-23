import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { io } from 'socket.io-client';
import { BellRing, DollarSign, ShoppingBag, PackageCheck, TrendingUp, ShieldCheck, LogIn, Phone, MapPin, RefreshCw, Users, UserPlus, UserMinus } from 'lucide-react';
import './styles.css';
import ErrorBoundary from './ErrorBoundary';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3000/api' : '');
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (API_BASE ? API_BASE.replace(/\/api\/?$/, '') : '');
const API_CONFIGURATION_ERROR = !API_BASE
  ? 'כתובת שרת ה-API חסרה. יש להגדיר VITE_API_URL בבניית אפליקציית הניהול.'
  : !SOCKET_URL ? 'כתובת עדכוני Socket חסרה. יש להגדיר VITE_SOCKET_URL.' : '';

function playAlertTone() {
  try {
    const audioUrl = new URL('bubble-pop-ui-alert-jam-fx-1-00-01.mp3', window.location.href);
    const audio = new Audio(audioUrl.href);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch {
    // Audio is best-effort; notification display and order processing continue normally.
  }
}

function getFulfillmentStatus(order) {
  return order.fulfillment?.status || (['shipped', 'delivered', 'cancelled'].includes(order.status) ? order.status : 'pending');
}

function getTokenRole(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).role || '';
  } catch {
    return '';
  }
}

function App() {
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalOrders: 0,
    orderStatusBreakdown: { pending: 0, preparing: 0, shipped: 0, delivered: 0, cancelled: 0 },
    topSellingProducts: []
  });
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [featuredProductId, setFeaturedProductId] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [categoryNotice, setCategoryNotice] = useState('');
  const [featuredNotice, setFeaturedNotice] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [notification, setNotification] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => localStorage.getItem('haruzim-admin-token') || '');
  const [login, setLogin] = useState({ email: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [error, setError] = useState('');
  const [orderFilter, setOrderFilter] = useState('active');
  const [savingOrder, setSavingOrder] = useState('');
  const [nextOrderCursor, setNextOrderCursor] = useState(null);
  const [managers, setManagers] = useState([]);
  const [managerForm, setManagerForm] = useState({ name: '', email: '', password: '' });
  const [managerError, setManagerError] = useState('');
  const [managerNotice, setManagerNotice] = useState('');
  const [managerBusy, setManagerBusy] = useState(false);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState(null);
  const [productForm, setProductForm] = useState({ name: '', description: '', category: '', price: '', promotionPrice: '', unitType: 'units', stockQuantity: '', imageUrl: '', active: true });
  const [productError, setProductError] = useState('');
  const [productBusy, setProductBusy] = useState(false);
  const [inlineProductDrafts, setInlineProductDrafts] = useState({});
  const [savingInlineProductId, setSavingInlineProductId] = useState('');
  const [isShabbatClosed, setIsShabbatClosed] = useState(false);
  const isOwner = getTokenRole(token) === 'admin';

  useEffect(() => {
    if (!token || API_CONFIGURATION_ERROR) {
      setLoading(false);
      return undefined;
    }
    const socket = io(SOCKET_URL, { auth: { token } });

    const handleNewOrder = (payload) => {
      const orderId = payload?.orderId || payload?._id || 'חדש';
      const total = payload?.total || 0;
      const incomingOrder = { ...payload, _id: String(orderId) };
      playAlertTone();
      setNotification({ orderId, total });
      setOrders((prev) => [incomingOrder, ...prev.filter((order) => order._id !== incomingOrder._id)]);
      setTimeout(() => setNotification(null), 7000);
    };

    const handleOrderUpdated = (payload) => {
      setOrders((prev) => prev.map((order) => String(order._id) === String(payload.orderId)
        ? { ...order, status: payload.status, payment: payload.payment, fulfillment: payload.fulfillment }
        : order));
    };

    socket.on('connect', () => {
      setIsConnected(true);
      fetchOrders().catch(() => setError('לא ניתן לרענן את ההזמנות כרגע.'));
    });
    socket.on('disconnect', () => setIsConnected(false));
    socket.on('newOrder', handleNewOrder);
    socket.on('orderUpdated', handleOrderUpdated);

    const fetchStats = async () => {
      const response = await fetch(`${API_BASE}/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 || response.status === 403) throw new Error('פג תוקף ההתחברות. יש להתחבר מחדש.');
      if (!response.ok) throw new Error('לא ניתן לטעון נתוני דוח.');
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    };

    const fetchOrders = async (cursor = null, append = false, preserveExisting = false) => {
      const query = cursor ? `?before=${encodeURIComponent(cursor.createdAt)}&id=${encodeURIComponent(cursor.id)}` : '';
      const response = await fetch(`${API_BASE}/admin/orders${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) throw new Error('פג תוקף ההתחברות. יש להתחבר מחדש.');
      if (!response.ok) throw new Error('לא ניתן לטעון הזמנות.');
      if (response.ok) {
        const data = await response.json();
        const incoming = data.orders || [];
        setOrders((previous) => {
          if (!append && !preserveExisting) return incoming;
          const merged = [...incoming, ...previous.filter((order) => !incoming.some((item) => String(item._id) === String(order._id)))];
          return merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        });
        if (!cursor) setNextOrderCursor(data.nextCursor || null);
        else setNextOrderCursor(data.nextCursor || null);
      }
    };

    const fetchProducts = async () => {
      const response = await fetch(`${API_BASE}/admin/products`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('לא ניתן לטעון את המלאי.');
      const data = await response.json();
      setProducts(data.products || []);
      setCategories(data.categories || []);
    };

    const fetchFeaturedSelection = async () => {
      const response = await fetch(`${API_BASE}/admin/catalog/featured-product`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('לא ניתן לטעון את בחירת המוצר המובלט.');
      const data = await response.json();
      setFeaturedProductId(data.productId || '');
    };

    const fetchManagers = async () => {
      const response = await fetch(`${API_BASE}/admin/managers`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('לא ניתן לטעון את רשימת המנהלים.');
      const data = await response.json();
      setManagers(data.managers || []);
    };

    const fetchShabbatStatus = async () => {
      const response = await fetch(`${API_BASE}/shabbat/status`);
      if (!response.ok) throw new Error('לא ניתן לבדוק את מצב פעילות החנות.');
      const data = await response.json();
      setIsShabbatClosed(Boolean(data.isShabbat));
    };

    const initData = async () => {
      setLoading(true);
      setError('');
      try {
        await Promise.all([fetchStats(), fetchOrders(), fetchProducts(), fetchFeaturedSelection(), fetchShabbatStatus(), isOwner ? fetchManagers() : Promise.resolve()]);
      } catch (fetchError) {
        setError(fetchError.message || 'שגיאה בטעינת הנתונים.');
        if (fetchError.message?.includes('פג תוקף')) {
          localStorage.removeItem('haruzim-admin-token');
          setToken('');
        }
      } finally {
        setLoading(false);
      }
    };

    initData();
    const refreshTimer = window.setInterval(() => {
      fetchOrders(null, false, true).catch(() => setError('החיבור לשרת אבד. ההזמנות יתעדכנו כשהחיבור יחזור.'));
      fetchStats().catch(() => {});
      fetchShabbatStatus().catch(() => {});
    }, 60000);

    socket.on('connect_error', () => setIsConnected(false));
    return () => {
      window.clearInterval(refreshTimer);
      socket.disconnect();
    };
  }, [token]);

  const totalStatusOrders = useMemo(
    () => Object.values(stats.orderStatusBreakdown).reduce((sum, value) => sum + Number(value || 0), 0),
    [stats.orderStatusBreakdown]
  );

  const loginAdmin = async (event) => {
    event.preventDefault();
    if (API_CONFIGURATION_ERROR) { setLoginError(API_CONFIGURATION_ERROR); return; }
    setLoginError('');
    try {
      const response = await fetch(`${API_BASE}/auth/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'ההתחברות נכשלה.');
      localStorage.setItem('haruzim-admin-token', data.token);
      setToken(data.token);
      setLogin({ email: '', password: '' });
    } catch (loginFailure) {
      setLoginError(loginFailure.message || 'לא ניתן להתחבר כרגע.');
    }
  };

  const createManager = async (event) => {
    event.preventDefault();
    if (isShabbatClosed) { setManagerError('החנות סגורה בשבת. ניהול חשבונות יתאפשר לאחר צאת השבת.'); return; }
    setManagerError('');
    setManagerNotice('');
    setManagerBusy(true);
    try {
      const response = await fetch(`${API_BASE}/admin/managers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(managerForm)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן ליצור את החשבון.');
      setManagers((previous) => [data.manager, ...previous]);
      setManagerForm({ name: '', email: '', password: '' });
      setManagerNotice(`החשבון של ${data.manager.name} נוצר. יש למסור לו את פרטי הכניסה באופן מאובטח.`);
    } catch (createError) {
      setManagerError(createError.message || 'שגיאה ביצירת החשבון.');
    } finally {
      setManagerBusy(false);
    }
  };

  const removeManager = async (manager) => {
    if (isShabbatClosed) { setManagerError('החנות סגורה בשבת. ניהול חשבונות יתאפשר לאחר צאת השבת.'); return; }
    if (!window.confirm(`להסיר את הגישה של ${manager.name}? החשבון יושבת ולא יימחק מההיסטוריה.`)) return;
    setManagerError('');
    setManagerNotice('');
    setManagerBusy(true);
    try {
      const response = await fetch(`${API_BASE}/admin/managers/${manager._id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן להסיר את הגישה.');
      setManagers((previous) => previous.map((item) => String(item._id) === String(manager._id) ? data.manager : item));
      setManagerNotice(`הגישה של ${manager.name} הוסרה.`);
    } catch (removeError) {
      setManagerError(removeError.message || 'שגיאה בהסרת הגישה.');
    } finally {
      setManagerBusy(false);
    }
  };

  const openNewProduct = () => {
    setEditingProductId(null);
    setProductForm({ name: '', description: '', category: categories[0]?._id || '', price: '', promotionPrice: '', unitType: 'units', stockQuantity: '', imageUrl: '', active: true });
    setProductError('');
    setProductModalOpen(true);
  };

  const openEditProduct = (product) => {
    setEditingProductId(String(product._id));
    setProductForm({
      name: product.name || '',
      description: product.description || '',
      category: String(product.category?._id || product.category || ''),
      price: String(product.price ?? ''),
      promotionPrice: product.promotion?.price == null ? '' : String(product.promotion.price),
      unitType: product.unitType || 'units',
      stockQuantity: product.stockQuantity == null ? '' : String(product.stockQuantity),
      imageUrl: product.imageUrl || '',
      active: product.active !== false
    });
    setProductError('');
    setProductModalOpen(true);
  };

  const saveProduct = async (event) => {
    event.preventDefault();
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון מלאי יתאפשר לאחר צאת השבת.'); return; }
    setProductError('');
    setProductBusy(true);
    const payload = {
      ...productForm,
      price: Number(productForm.price),
      promotionPrice: productForm.promotionPrice === '' ? null : Number(productForm.promotionPrice),
      stockQuantity: productForm.stockQuantity === '' ? null : Number(productForm.stockQuantity)
    };
    try {
      const editing = Boolean(editingProductId);
      const response = await fetch(editing ? `${API_BASE}/admin/products/${editingProductId}` : `${API_BASE}/admin/products`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לשמור את המוצר.');
      setProducts((previous) => editing
        ? previous.map((item) => String(item._id) === String(data.product._id) ? data.product : item)
        : [...previous, data.product].sort((a, b) => a.name.localeCompare(b.name, 'he')));
      setProductModalOpen(false);
    } catch (saveError) {
      setProductError(saveError.message || 'שגיאה בשמירת המוצר.');
    } finally {
      setProductBusy(false);
    }
  };

  const setProductAvailability = async (product, active) => {
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון מלאי יתאפשר לאחר צאת השבת.'); return; }
    const categoryId = String(product.category?._id || product.category || '');
    setProductError('');
    setProductBusy(true);
    try {
      const response = await fetch(`${API_BASE}/admin/products/${product._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: product.name,
          description: product.description || '',
          category: categoryId,
          price: product.price,
          promotionPrice: product.promotion?.price ?? null,
          unitType: product.unitType || 'units',
          stockQuantity: product.stockQuantity,
          imageUrl: product.imageUrl || '',
          active
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לשנות את זמינות המוצר.');
      setProducts((previous) => previous.map((item) => String(item._id) === String(data.product._id) ? data.product : item));
    } catch (availabilityError) {
      setProductError(availabilityError.message || 'שגיאה בעדכון הזמינות.');
    } finally {
      setProductBusy(false);
    }
  };

  const updateInlineProductDraft = (product, field, value) => {
    const productId = String(product._id);
    setInlineProductDrafts((previous) => ({
      ...previous,
      [productId]: {
        price: previous[productId]?.price ?? String(product.price ?? ''),
        stockQuantity: previous[productId]?.stockQuantity ?? (product.stockQuantity == null ? '' : String(product.stockQuantity)),
        [field]: value
      }
    }));
  };

  const saveInlineProduct = async (product) => {
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון מלאי יתאפשר לאחר צאת השבת.'); return; }
    const productId = String(product._id);
    const draft = inlineProductDrafts[productId];
    if (!draft) return;
    setProductError('');
    setSavingInlineProductId(productId);
    try {
      const response = await fetch(`${API_BASE}/admin/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: product.name,
          description: product.description || '',
          category: String(product.category?._id || product.category || ''),
          price: Number(draft.price),
          promotionPrice: product.promotion?.price ?? null,
          unitType: product.unitType || 'units',
          stockQuantity: draft.stockQuantity === '' ? null : Number(draft.stockQuantity),
          imageUrl: product.imageUrl || '',
          active: product.active !== false
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לעדכן את המחיר והמלאי.');
      setProducts((previous) => previous.map((item) => String(item._id) === String(data.product._id) ? data.product : item));
      setInlineProductDrafts((previous) => {
        const next = { ...previous };
        delete next[productId];
        return next;
      });
    } catch (inlineSaveError) {
      setProductError(inlineSaveError.message || 'שגיאה בעדכון המחיר והמלאי.');
    } finally {
      setSavingInlineProductId('');
    }
  };

  const deleteProduct = async (product) => {
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון מלאי יתאפשר לאחר צאת השבת.'); return; }
    if (!window.confirm(`להסיר את ״${product.name}״ מהחנות? המוצר יישאר בהיסטוריית הזמנות קודמות.`)) return;
    setProductError('');
    setProductBusy(true);
    try {
      const response = await fetch(`${API_BASE}/admin/products/${product._id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן להסיר את המוצר.');
      setProducts((previous) => previous.map((item) => String(item._id) === String(product._id) ? data.product : item));
    } catch (deleteError) {
      setProductError(deleteError.message || 'שגיאה בהסרת המוצר.');
    } finally {
      setProductBusy(false);
    }
  };

  const createCategory = async (event) => {
    event.preventDefault();
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון קטגוריות יתאפשר לאחר צאת השבת.'); return; }
    setCategoryNotice('');
    setProductError('');
    try {
      const response = await fetch(`${API_BASE}/admin/catalog/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: categoryName })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן ליצור את הקטגוריה.');
      setCategories((previous) => [...previous, data.category].sort((a, b) => a.name.localeCompare(b.name, 'he')));
      setCategoryName('');
      setCategoryNotice(`הקטגוריה ״${data.category.name}״ נוספה וניתן לשייך אליה מוצרים.`);
    } catch (error) {
      setProductError(error.message || 'שגיאה ביצירת הקטגוריה.');
    }
  };

  const saveFeaturedProduct = async () => {
    if (isShabbatClosed) { setProductError('החנות סגורה בשבת. עדכון האתר יתאפשר לאחר צאת השבת.'); return; }
    setFeaturedNotice('');
    setProductError('');
    setProductBusy(true);
    try {
      const response = await fetch(`${API_BASE}/admin/catalog/featured-product`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productId: featuredProductId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לשמור את המוצר המובלט.');
      setFeaturedProductId(data.productId || '');
      setFeaturedNotice('המוצר שיוצג בראש אתר הלקוחות עודכן.');
    } catch (error) {
      setProductError(error.message || 'שגיאה בשמירת המוצר המובלט.');
    } finally {
      setProductBusy(false);
    }
  };

  const updateOrder = async (order, changes) => {
    if (isShabbatClosed) { setError('החנות סגורה בשבת. עדכון הזמנות יתאפשר לאחר צאת השבת.'); return; }
    if (changes.fulfillmentStatus === 'cancelled' && !window.confirm('לבטל את ההזמנה ולהחזיר את המוצרים למלאי?')) return;
    setSavingOrder(String(order._id));
    setError('');
    const updated = {
      paymentStatus: changes.paymentStatus || order.payment?.status || 'pending',
      fulfillmentStatus: changes.fulfillmentStatus || getFulfillmentStatus(order)
    };
    try {
      const response = await fetch(`${API_BASE}/admin/orders/${order._id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(updated)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'עדכון ההזמנה נכשל.');
      setOrders((prev) => prev.map((item) => String(item._id) === String(order._id) ? data.order : item));
      const statsResponse = await fetch(`${API_BASE}/admin/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (statsResponse.ok) setStats(await statsResponse.json());
    } catch (updateError) {
      setError(updateError.message || 'לא ניתן לעדכן את ההזמנה.');
    } finally {
      setSavingOrder('');
    }
  };

  const signOut = () => {
    localStorage.removeItem('haruzim-admin-token');
    setToken('');
    setOrders([]);
    setNextOrderCursor(null);
  };

  const loadMoreOrders = async () => {
    if (!nextOrderCursor) return;
    try {
      await fetch(`${API_BASE}/admin/orders?before=${encodeURIComponent(nextOrderCursor.createdAt)}&id=${encodeURIComponent(nextOrderCursor.id)}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לטעון את היסטוריית ההזמנות.');
        setOrders((previous) => [...previous, ...(data.orders || []).filter((order) => !previous.some((item) => String(item._id) === String(order._id)))]);
        setNextOrderCursor(data.nextCursor || null);
      });
    } catch (loadError) {
      setError(loadError.message || 'לא ניתן לטעון את היסטוריית ההזמנות.');
    }
  };

  const isOrderComplete = (order) => ['delivered', 'cancelled'].includes(getFulfillmentStatus(order));
  const visibleOrders = orders.filter((order) => orderFilter === 'all' || (orderFilter === 'history' ? isOrderComplete(order) : !isOrderComplete(order)));
  const statusLabels = { pending_payment: 'ממתין לתשלום', pending: 'ממתין לטיפול', preparing: 'בהכנה', shipped: 'נשלח', delivered: 'נמסר', cancelled: 'בוטל' };
  const scrollToSection = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!token) {
    return (
      <main className="login-screen" dir="rtl">
        <form className="login-card" onSubmit={loginAdmin}>
          <ShieldCheck size={38} />
          <p className="eyebrow">Haruzim Market</p>
          <h1>כניסת צוות החנות</h1>
          <label>כתובת אימייל<input type="email" autoComplete="username" required value={login.email} onChange={(event) => setLogin((prev) => ({ ...prev, email: event.target.value }))} /></label>
          <label>סיסמה<input type="password" autoComplete="current-password" required value={login.password} onChange={(event) => setLogin((prev) => ({ ...prev, password: event.target.value }))} /></label>
          {loginError && <p className="error-banner" role="alert">{loginError}</p>}
          {API_CONFIGURATION_ERROR && <p className="error-banner" role="alert">{API_CONFIGURATION_ERROR}</p>}
          <button className="primary-btn" type="submit"><LogIn size={16} /> התחברות</button>
        </form>
      </main>
    );
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand-block">
          <ShieldCheck size={32} />
          <div>
            <small>Haruzim</small>
            <h2>Admin Console</h2>
          </div>
        </div>

        <nav className="nav-list">
          <button className="nav-item active" onClick={() => scrollToSection('dashboard')}>דשבורד</button>
          <button className="nav-item" onClick={() => scrollToSection('orders')}>הזמנות והיסטוריה</button>
          <button className="nav-item" onClick={() => scrollToSection('inventory')}>מלאי</button>
          <button className="nav-item" onClick={() => scrollToSection('connection')}>חיבור מערכת</button>
          {isOwner && <button className="nav-item" onClick={() => scrollToSection('managers')}>ניהול מנהלים</button>}
        </nav>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <p className="eyebrow">שליטה בזמן אמת</p>
            <h1>לוח בקרה</h1>
          </div>
          <div className={`status-pill ${isConnected ? 'online' : 'offline'}`}>
            <BellRing size={14} /> {isConnected ? 'מחובר' : 'מנותק'}
          </div>
          <button className="logout-btn" type="button" onClick={signOut}>יציאה</button>
        </header>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {isShabbatClosed && <div className="shabbat-admin-banner" role="status"><strong>שבת שלום — החנות סגורה לעדכונים כעת.</strong><span>אפשר לצפות בנתונים; עריכת הזמנות, מלאי וקטגוריות תתאפשר לאחר צאת השבת.</span></div>}

        {notification && (
          <div className="notification-banner">
            <strong>הזמנה חדשה:</strong> {notification.orderId} • {notification.total}₪
          </div>
        )}

        {loading ? (
          <section className="stats-grid skeleton-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="stat-card skeleton-stat-card" />
            ))}
          </section>
        ) : (
          <>
            <section className="stats-grid" id="dashboard">
              <div className="stat-card">
                <DollarSign size={18} />
                <div>
                  <small>הכנסות</small>
                  <strong>{Number(stats.totalRevenue || 0).toFixed(2)}₪</strong>
                </div>
              </div>
              <div className="stat-card">
                <ShoppingBag size={18} />
                <div>
                  <small>הזמנות</small>
                  <strong>{stats.totalOrders || 0}</strong>
                </div>
              </div>
              <div className="stat-card">
                <PackageCheck size={18} />
                <div>
                  <small>בתהליך</small>
                  <strong>{stats.orderStatusBreakdown?.preparing || 0}</strong>
                </div>
              </div>
              <div className="stat-card">
                <TrendingUp size={18} />
                <div>
                  <small>מוצרים מובילים</small>
                  <strong>{stats.topSellingProducts?.length || 0}</strong>
                </div>
              </div>
            </section>

            <section className="dashboard-grid">
              <div className="panel-box">
                <div className="panel-header">
                  <h3>התפלגות סטטוסים</h3>
                </div>
                <div className="status-list">
                  {Object.entries(stats.orderStatusBreakdown || {}).map(([key, value]) => (
                    <div key={key} className="status-row">
                      <span>{statusLabels[key] || key}</span>
                      <div className="progress-bar">
                        <div style={{ width: `${totalStatusOrders ? (value / totalStatusOrders) * 100 : 0}%` }} />
                      </div>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel-box">
                <div className="panel-header">
                  <h3>מוצרים מובילים</h3>
                </div>
                <ul className="simple-list">
                  {(stats.topSellingProducts || []).map((item, index) => (
                    <li key={item.productId || index}>
                      <span>{index + 1}. {item.name}</span>
                      <strong>{item.totalSold} יח'</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="panel-box orders-panel" id="orders">
              <div className="orders-heading">
                <div><p className="eyebrow">טיפול ומעקב</p><h2>הזמנות</h2></div>
                <div className="filter-actions">
                  <button type="button" className={orderFilter === 'active' ? 'filter-btn active' : 'filter-btn'} onClick={() => setOrderFilter('active')}>פתוחות</button>
                  <button type="button" className={orderFilter === 'history' ? 'filter-btn active' : 'filter-btn'} onClick={() => setOrderFilter('history')}>היסטוריה</button>
                  <button type="button" className={orderFilter === 'all' ? 'filter-btn active' : 'filter-btn'} onClick={() => setOrderFilter('all')}>הכול</button>
                </div>
              </div>
              <div className="orders-table">
                {visibleOrders.map((order) => (
                  <div key={order._id} className="order-row">
                    <div className="order-customer">
                      <strong>{order.customer?.name || 'לקוח'}</strong>
                      <small>מס׳ {String(order._id).slice(-8)} · {new Date(order.createdAt).toLocaleString('he-IL')}</small>
                      <small><Phone size={13} /> {order.customer?.phone || '—'}</small>
                      <small><MapPin size={13} /> {[order.customer?.address?.street, order.customer?.address?.apartment, order.customer?.address?.city].filter(Boolean).join(', ')}</small>
                    </div>
                    <strong className="order-total">{Number(order.total || 0).toFixed(2)}₪</strong>
                    <div className="order-statuses">
                      <span className={`order-badge ${order.payment?.status === 'paid' ? 'paid' : 'waiting'}`}>{order.payment?.status === 'paid' ? 'שולם' : 'ממתין לתשלום'}</span>
                      <span className={`order-badge ${['shipped', 'delivered'].includes(getFulfillmentStatus(order)) ? 'shipped' : 'waiting'}`}>{getFulfillmentStatus(order) === 'shipped' ? 'נשלח' : getFulfillmentStatus(order) === 'delivered' ? 'נמסר' : getFulfillmentStatus(order) === 'cancelled' ? 'בוטל' : 'ממתין למשלוח'}</span>
                    </div>
                    <div className="order-actions">
                      <button type="button" disabled={isShabbatClosed || savingOrder === String(order._id) || order.payment?.status === 'paid' || getFulfillmentStatus(order) === 'cancelled'} onClick={() => updateOrder(order, { paymentStatus: 'paid' })}>{savingOrder === String(order._id) ? 'שומר…' : order.payment?.status === 'paid' ? 'שולם ✓' : 'סמן כשולם'}</button>
                      <button type="button" disabled={isShabbatClosed || savingOrder === String(order._id) || getFulfillmentStatus(order) !== 'pending'} onClick={() => updateOrder(order, { fulfillmentStatus: 'shipped' })}>{['shipped', 'delivered'].includes(getFulfillmentStatus(order)) ? 'נשלח ✓' : 'סמן כנשלח'}</button>
                      <button type="button" disabled={isShabbatClosed || savingOrder === String(order._id) || getFulfillmentStatus(order) !== 'shipped'} onClick={() => updateOrder(order, { fulfillmentStatus: 'delivered' })}>{getFulfillmentStatus(order) === 'delivered' ? 'נמסר ✓' : 'סמן כנמסר'}</button>
                      {getFulfillmentStatus(order) === 'pending' && order.payment?.status !== 'paid' && <button type="button" disabled={isShabbatClosed || savingOrder === String(order._id)} onClick={() => updateOrder(order, { fulfillmentStatus: 'cancelled' })}>בטל הזמנה</button>}
                    </div>
                    <details className="order-details"><summary>פריטים והערות</summary><ul>{(order.items || []).map((item, index) => <li key={`${item.name}-${index}`}>{item.name} × {item.quantity} {item.unitType === 'weight' ? 'ק״ג' : 'יח׳'} · {Number(item.total || item.unitPrice * item.quantity || 0).toFixed(2)}₪</li>)}</ul>{order.customer?.notes && <p>הערה: {order.customer.notes}</p>}</details>
                  </div>
                ))}
                {!visibleOrders.length && <p className="empty-orders">{orderFilter === 'history' ? 'אין עדיין הזמנות בהיסטוריה.' : 'אין הזמנות להצגה.'}</p>}
              </div>
              {nextOrderCursor && <button className="load-more-btn" type="button" onClick={loadMoreOrders}>טעינת הזמנות קודמות</button>}
            </section>

            <section className="dashboard-grid">
              <div className="panel-box inventory-panel" id="inventory">
                <div className="panel-header">
                  <h3>ניהול מלאי</h3>
                  <button className="primary-btn inventory-add-btn" type="button" disabled={isShabbatClosed} onClick={openNewProduct}><UserPlus size={15} /> הוסף מוצר חדש</button>
                </div>
                {productError && <p className="error-banner" role="alert">{productError}</p>}
                <div className="inventory-settings-row">
                  <form className="category-create-form" onSubmit={createCategory}><label>קטגוריה חדשה<input required minLength="2" maxLength="80" disabled={isShabbatClosed} value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="למשל: ירקות ופירות" /></label><button className="secondary-btn" type="submit" disabled={isShabbatClosed}>הוסף קטגוריה</button></form>
                  <div className="featured-select-form"><label>מוצר בולט בראש האתר<select disabled={isShabbatClosed} value={featuredProductId} onChange={(event) => setFeaturedProductId(event.target.value)}><option value="">ללא מוצר מובלט</option>{products.filter((product) => product.active && (product.stockQuantity == null || Number(product.stockQuantity) > 0)).map((product) => <option key={product._id} value={product._id}>{product.name}</option>)}</select></label><button className="secondary-btn" type="button" disabled={productBusy || isShabbatClosed} onClick={saveFeaturedProduct}>שמור בחירה</button></div>
                </div>
                {(categoryNotice || featuredNotice) && <p className="manager-notice" role="status">{categoryNotice || featuredNotice}</p>}
                <div className="inventory-table-wrap">
                  <table className="inventory-table">
                    <thead><tr><th>מוצר</th><th>קטגוריה</th><th>מחיר</th><th>מלאי</th><th>זמינות בחנות</th><th>פעולות</th></tr></thead>
                    <tbody>
                  {products.map((product) => (
                    <tr key={product._id} className={product.active ? '' : 'product-inactive'}>
                      <td><div className="inventory-product-cell">{product.imageUrl ? <img src={product.imageUrl} alt={product.name || ''} /> : <span className="product-image-placeholder">{product.name?.slice(0, 1) || 'מ'}</span>}<div><strong>{product.name}</strong><small>{product.unitType === 'weight' ? 'לפי ק״ג' : 'לפי יחידה'}</small></div></div></td>
                      <td><span>{product.category?.name || '—'}</span><small className="inventory-sku">SKU: {product.sku || String(product._id).slice(-8)}</small></td>
                      <td><label className="inventory-inline-field"><span className="visually-hidden">מחיר בשקלים</span><input aria-label={`מחיר בשקלים עבור ${product.name}`} type="number" min="0" max="1000000" step="0.01" value={inlineProductDrafts[String(product._id)]?.price ?? String(product.price ?? 0)} disabled={isShabbatClosed || savingInlineProductId === String(product._id)} onChange={(event) => updateInlineProductDraft(product, 'price', event.target.value)} /><span>₪</span></label>{product.promotion?.price != null && <small className="inventory-promo">מבצע {Number(product.promotion.price).toFixed(2)}₪</small>}</td>
                      <td><label className="inventory-inline-field"><input className="inventory-stock-input" aria-label={`כמות במלאי ${product.unitType === 'weight' ? 'בקילוגרמים' : 'ביחידות'} עבור ${product.name}`} type="number" min="0" max="1000000" step={product.unitType === 'weight' ? '0.01' : '1'} placeholder="ללא הגבלה" value={inlineProductDrafts[String(product._id)]?.stockQuantity ?? (product.stockQuantity == null ? '' : String(product.stockQuantity))} disabled={isShabbatClosed || savingInlineProductId === String(product._id)} onChange={(event) => updateInlineProductDraft(product, 'stockQuantity', event.target.value)} /><span>{product.stockQuantity == null ? (product.unitType === 'weight' ? 'ק״ג' : 'יח׳') : product.unitType === 'weight' ? 'ק״ג' : 'יח׳'}</span></label></td>
                      <td><label className="availability-switch" title={product.active ? 'המוצר מוצג בחנות' : 'המוצר מוסתר מהחנות'}><input type="checkbox" checked={product.active !== false} disabled={productBusy || isShabbatClosed} onChange={(event) => setProductAvailability(product, event.target.checked)} /><span className="switch-track" /><span className="availability-label">{product.active ? 'במלאי' : 'אזל מהמלאי'}</span></label></td>
                      <td><div className="inventory-actions"><button className="inventory-save-btn" type="button" onClick={() => saveInlineProduct(product)} disabled={productBusy || savingInlineProductId === String(product._id) || isShabbatClosed || !inlineProductDrafts[String(product._id)]}>{savingInlineProductId === String(product._id) ? 'שומר…' : 'שמור'}</button><button type="button" onClick={() => openEditProduct(product)} disabled={productBusy || isShabbatClosed}>עריכה</button><button type="button" onClick={() => deleteProduct(product)} disabled={productBusy || isShabbatClosed || !product.active}>הסר</button></div></td>
                    </tr>
                  ))}
                    {!products.length && <tr><td colSpan="6" className="inventory-empty">אין מוצרים במלאי. אפשר להוסיף מוצר חדש.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel-box" id="connection"><div className="panel-header"><h3>חיבור מערכת</h3></div><p>ההזמנות מתעדכנות בזמן אמת. אם החיבור נותק, בדקו שהשרת זמין.</p><button className="refresh-btn" type="button" onClick={() => window.location.reload()}><RefreshCw size={15} /> רענון נתונים</button></div>
            </section>

            {isOwner && (
              <section className="panel-box manager-panel" id="managers">
                <div className="panel-header manager-heading"><div><p className="eyebrow">גישה לצוות</p><h2><Users size={21} /> ניהול מנהלים</h2></div></div>
                <p className="manager-description">אפשר ליצור חשבון לצוות או להשבית גישה. סיסמאות נשמרות בשרת כ-hash ולא מוצגות לאחר יצירת החשבון.</p>
                <form className="manager-form" onSubmit={createManager}>
                  <label>שם מלא<input required minLength="2" maxLength="100" value={managerForm.name} onChange={(event) => setManagerForm((previous) => ({ ...previous, name: event.target.value }))} placeholder="שם המנהל" /></label>
                  <label>אימייל כניסה<input required type="email" autoComplete="off" value={managerForm.email} onChange={(event) => setManagerForm((previous) => ({ ...previous, email: event.target.value }))} placeholder="manager@example.com" /></label>
                  <label>סיסמת כניסה<input required type="password" minLength="12" maxLength="128" autoComplete="new-password" value={managerForm.password} onChange={(event) => setManagerForm((previous) => ({ ...previous, password: event.target.value }))} placeholder="לפחות 12 תווים" /></label>
                  <button className="primary-btn" type="submit" disabled={managerBusy || isShabbatClosed}><UserPlus size={16} /> {managerBusy ? 'שומר…' : 'הוסף מנהל'}</button>
                </form>
                {managerError && <p className="error-banner" role="alert">{managerError}</p>}
                {managerNotice && <p className="manager-notice" role="status">{managerNotice}</p>}
                <div className="manager-list">
                  {managers.map((manager) => (
                    <div className={`manager-row ${manager.active ? '' : 'inactive'}`} key={manager._id}>
                      <div><strong>{manager.name}</strong><small>{manager.email}</small></div>
                      <span className={`manager-state ${manager.active ? 'active' : ''}`}>{manager.active ? 'פעיל' : 'הגישה הוסרה'}</span>
                      {manager.active && <button type="button" className="remove-manager-btn" disabled={managerBusy || isShabbatClosed} onClick={() => removeManager(manager)}><UserMinus size={15} /> הסר גישה</button>}
                    </div>
                  ))}
                  {!managers.length && <p className="empty-orders">עדיין לא נוספו מנהלים.</p>}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {productModalOpen && (
        <div className="product-modal-backdrop" onClick={() => !productBusy && setProductModalOpen(false)}>
          <form className="product-modal" onSubmit={saveProduct} onClick={(event) => event.stopPropagation()}>
            <div className="product-modal-heading"><div><p className="eyebrow">קטלוג החנות</p><h2>{editingProductId ? 'עריכת מוצר' : 'הוספת מוצר חדש'}</h2></div><button type="button" aria-label="סגירה" onClick={() => setProductModalOpen(false)}>×</button></div>
            <div className="product-form-grid">
              <label>שם המוצר<input required minLength="2" maxLength="160" value={productForm.name} onChange={(event) => setProductForm((previous) => ({ ...previous, name: event.target.value }))} /></label>
              <label>קטגוריה<select required value={productForm.category} onChange={(event) => setProductForm((previous) => ({ ...previous, category: event.target.value }))}><option value="">בחרו קטגוריה</option>{categories.map((category) => <option key={category._id} value={category._id}>{category.name}</option>)}</select></label>
              <label>מחיר רגיל (₪)<input required type="number" min="0" step="0.01" value={productForm.price} onChange={(event) => setProductForm((previous) => ({ ...previous, price: event.target.value }))} /></label>
              <label>מחיר מבצע (אופציונלי)<input type="number" min="0" step="0.01" value={productForm.promotionPrice} onChange={(event) => setProductForm((previous) => ({ ...previous, promotionPrice: event.target.value }))} placeholder="ללא מבצע" /></label>
              <label>סוג מכירה<select value={productForm.unitType} onChange={(event) => setProductForm((previous) => ({ ...previous, unitType: event.target.value }))}><option value="units">יחידות</option><option value="weight">משקל (ק״ג)</option></select></label>
              <label>כמות במלאי ({productForm.unitType === 'weight' ? 'ק״ג' : 'יחידות'})<input type="number" min="0" max="1000000" step={productForm.unitType === 'weight' ? '0.01' : '1'} placeholder="ללא הגבלה" value={productForm.stockQuantity} onChange={(event) => setProductForm((previous) => ({ ...previous, stockQuantity: event.target.value }))} /></label>
              <label className="product-image-url-field">קישור לתמונה<input type="url" maxLength="2000" value={productForm.imageUrl} onChange={(event) => setProductForm((previous) => ({ ...previous, imageUrl: event.target.value }))} placeholder="https://example.com/product.jpg" /></label>
              <label className="product-description-field">תיאור (אופציונלי)<textarea rows="3" maxLength="2000" value={productForm.description} onChange={(event) => setProductForm((previous) => ({ ...previous, description: event.target.value }))} /></label>
            </div>
            {productForm.imageUrl && <div className="product-image-preview"><img src={productForm.imageUrl} alt="תצוגה מקדימה של המוצר" onError={(event) => { event.currentTarget.style.display = 'none'; }} /><span>תצוגה מקדימה</span></div>}
            {productError && <p className="error-banner" role="alert">{productError}</p>}
            {!categories.length && <p className="error-banner" role="alert">אין קטגוריות פעילות. יש להוסיף קטגוריה לפני יצירת מוצר.</p>}
            <div className="product-modal-actions"><button type="button" className="modal-cancel-btn" disabled={productBusy} onClick={() => setProductModalOpen(false)}>ביטול</button><button type="submit" className="primary-btn" disabled={productBusy || isShabbatClosed || !categories.length}>{productBusy ? 'שומר…' : editingProductId ? 'שמירת שינויים' : 'יצירת מוצר'}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
