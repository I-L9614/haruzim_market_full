import { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, ShoppingCart, RefreshCw, UserRound, LogOut, Sparkles, WifiOff } from 'lucide-react';
import Catalog from './Catalog';
import Cart from './Cart';
import Checkout from './Checkout';
import CustomerAuthModal from './CustomerAuthModal';
import OrderConfirmation from './OrderConfirmation';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3000/api' : '');

function getStoredOrderIds() {
  try {
    const value = JSON.parse(localStorage.getItem('haruzim-order-ids') || '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}

function getStoredCustomerToken() {
  try { return localStorage.getItem('haruzim-customer-token') || ''; } catch { return ''; }
}

const defaultCustomer = {
  name: '',
  phone: '',
  email: '',
  address: { street: '', city: '', apartment: '' },
  notes: ''
};

function App() {
  const [products, setProducts] = useState([]);
  const [featuredProduct, setFeaturedProduct] = useState(null);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedProductQuantity, setSelectedProductQuantity] = useState('1');
  const [featuredQuantity, setFeaturedQuantity] = useState('1');
  const [customer, setCustomer] = useState(defaultCustomer);
  const [orders, setOrders] = useState([]);
  const [trackedOrderIds, setTrackedOrderIds] = useState(getStoredOrderIds);
  const [trackingOrderId, setTrackingOrderId] = useState('');
  const [trackingError, setTrackingError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [checkoutResult, setCheckoutResult] = useState(null);
  const [stockIssue, setStockIssue] = useState(null);
  const [isShabbatBlocked, setIsShabbatBlocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authToken, setAuthToken] = useState(getStoredCustomerToken);
  const [account, setAccount] = useState(() => {
    try { return JSON.parse(localStorage.getItem('haruzim-customer-user') || 'null'); } catch { return null; }
  });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [reorderNotice, setReorderNotice] = useState('');

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setCatalogError('');
    try {
      if (!API_BASE) throw new Error('Catalog API is not configured.');
      const [catalogRes, categoriesRes, featuredRes] = await Promise.all([
        fetch(`${API_BASE}/catalog`),
        fetch(`${API_BASE}/categories`),
        fetch(`${API_BASE}/featured-product`)
      ]);

      if (catalogRes.status === 503 || categoriesRes.status === 503 || featuredRes.status === 503) {
        setIsShabbatBlocked(true);
        return;
      }
      if (!catalogRes.ok || !categoriesRes.ok || !featuredRes.ok) throw new Error('Catalog request failed.');

      const catalogData = await catalogRes.json();
      const categoryData = await categoriesRes.json();
      const featuredData = await featuredRes.json();
      setProducts(catalogData.products || []);
      setCategories(categoryData.categories || []);
      setFeaturedProduct(featuredData.product || null);
    } catch (error) {
      console.error(error);
      setCatalogError('catalog-unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  useEffect(() => {
    let isMounted = true;
    const checkStoreHours = async () => {
      try {
        const response = await fetch(`${API_BASE}/shabbat/status`);
        if (!response.ok) return;
        const data = await response.json();
        if (isMounted) setIsShabbatBlocked(Boolean(data.isShabbat));
      } catch {
        // Catalog and checkout endpoints still enforce store hours if polling fails.
      }
    };
    checkStoreHours();
    const timer = window.setInterval(checkStoreHours, 60000);
    return () => { isMounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (authToken) {
      let isMounted = true;
      const refreshAccountOrders = async () => {
        try {
          const response = await fetch(`${API_BASE}/customer/orders`, { headers: { Authorization: `Bearer ${authToken}` } });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לטעון את ההזמנות בחשבון.');
          if (isMounted) {
            setOrders(data.orders || []);
            setTrackingError('');
          }
        } catch (error) {
          if (isMounted) setTrackingError(error.message || 'לא ניתן לטעון את ההזמנות בחשבון.');
        }
      };
      refreshAccountOrders();
      const timer = window.setInterval(refreshAccountOrders, 30000);
      return () => { isMounted = false; window.clearInterval(timer); };
    }
    if (!customer.phone || !trackedOrderIds.length) {
      setOrders([]);
      return undefined;
    }
    let isMounted = true;
    const refreshOrders = async () => {
      try {
        const outcomes = await Promise.allSettled(trackedOrderIds.map(async (id) => {
          const response = await fetch(`${API_BASE}/orders/${encodeURIComponent(id)}/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: customer.phone })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לאמת פרטי מעקב.');
          return data.order;
        }));
        const results = outcomes.filter((result) => result.status === 'fulfilled').map((result) => result.value);
        if (isMounted) {
          setOrders(results);
          setTrackingError(outcomes.some((result) => result.status === 'rejected') ? 'לא ניתן לאמת חלק מההזמנות. ודאו שהטלפון תואם למספר שנמסר בהזמנה.' : '');
        }
      } catch (error) {
        if (isMounted) setTrackingError(error.message || 'לא ניתן לטעון את היסטוריית ההזמנות.');
      }
    };
    refreshOrders();
    const timer = window.setInterval(refreshOrders, 30000);
    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [authToken, customer.phone, trackedOrderIds]);

  const handleAuthenticated = useCallback(({ token, user }) => {
    try {
      localStorage.setItem('haruzim-customer-token', token);
      localStorage.setItem('haruzim-customer-user', JSON.stringify(user));
    } catch { /* keep the signed-in session in memory if browser storage is unavailable */ }
    setAuthToken(token);
    setAccount(user);
    setCustomer((previous) => ({ ...previous, name: user.name || previous.name, email: user.email || previous.email }));
    setShowAuthModal(false);
  }, []);

  const signOut = () => {
    try {
      localStorage.removeItem('haruzim-customer-token');
      localStorage.removeItem('haruzim-customer-user');
    } catch { /* clear in-memory authentication even if storage is unavailable */ }
    setAuthToken('');
    setAccount(null);
    setOrders([]);
  };

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0),
    [cart]
  );

  const addToCart = (product, requestedQuantity = 1) => {
    const quantity = Number(requestedQuantity);
    const isWeightProduct = product.unitType === 'weight';
    if (isShabbatBlocked || !Number.isFinite(quantity) || quantity <= 0 || (!isWeightProduct && !Number.isInteger(quantity))) return;
    if (product.stockQuantity != null && (product.stockQuantity <= 0 || quantity > product.stockQuantity)) return;
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === String(product._id));
      if (existing) {
        const nextQuantity = existing.quantity + quantity;
        return prev.map((item) => item.productId === String(product._id)
          ? { ...item, quantity: product.stockQuantity == null ? nextQuantity : Math.min(nextQuantity, product.stockQuantity) }
          : item);
      }

      return [...prev, {
        productId: String(product._id),
        name: product.name,
        quantity,
        price: product.promotion?.price ?? product.price,
        stockQuantity: product.stockQuantity,
        unitType: product.unitType || 'units',
        category: product.category
      }];
    });
  };

  const updateQuantity = (productId, requestedQuantity) => {
    setCart((prev) => prev.map((item) => {
      if (item.productId !== productId) return item;
      const parsedQuantity = Number(requestedQuantity);
      if (!Number.isFinite(parsedQuantity)) return item;
      const minimum = item.unitType === 'weight' ? 0.01 : 1;
      const normalizedQuantity = item.unitType === 'weight' ? Math.max(minimum, parsedQuantity) : Math.max(minimum, Math.round(parsedQuantity));
      return { ...item, quantity: item.stockQuantity == null ? normalizedQuantity : Math.min(Number(item.stockQuantity), normalizedQuantity) };
    }));
  };

  const removeFromCart = (productId) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
  };

  const validateCart = async () => {
    if (!cart.length) {
      setCheckoutResult({ ok: false, message: 'העגלה ריקה. יש להוסיף מוצרים לפני שליחת ההזמנה.' });
      return false;
    }

    try {
      const response = await fetch(`${API_BASE}/checkout/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((item) => ({
            productId: item.productId,
            quantity: item.quantity
          }))
        })
      });

      const data = await response.json();
      if (!response.ok || data.stock_issue) {
        setStockIssue({
          missingItems: data.missingItems || [],
          validItems: data.validItems || [],
          message: data.error || data.message || 'העגלה כוללת מוצרים שלא זמינים כעת.'
        });
        return false;
      }

      setStockIssue(null);
      return true;
    } catch (error) {
      console.error(error);
      setCheckoutResult({ ok: false, message: 'לא ניתן לבדוק מלאי כרגע. בדקו את החיבור ונסו שוב.' });
      return false;
    }
  };

  const handleSubmitOrder = async () => {
    if (isShabbatBlocked) {
      setCheckoutResult({ ok: false, message: 'שבת שלום — האתר סגור להזמנות כעת. נשמח לקבל את הזמנתכם במוצאי שבת.' });
      return;
    }

    const isCustomerValid = customer.name.trim() && /^\+?[0-9\s()-]{9,20}$/.test(customer.phone) && customer.address.street.trim() && customer.address.city.trim();
    if (!isCustomerValid) {
      setCheckoutResult({ ok: false, message: 'נא למלא שם, טלפון תקין, רחוב ועיר.' });
      return;
    }

    setIsSubmitting(true);

    try {
      const isValid = await validateCart();
      if (!isValid) return;
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({
          customer,
          items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity }))
        })
      });

      const data = await response.json();
      if (!response.ok) {
        if (data.stock_issue) setStockIssue({
          missingItems: data.missingItems || [],
          validItems: data.validItems || [],
          message: data.error || data.message || 'חלק מהמוצרים אינם זמינים עוד במלאי.'
        });
        setCheckoutResult({ ok: false, message: data.error || data.message || 'לא ניתן להשלים את ההזמנה.' });
        return;
      }

      const order = data.order;
      if (!order?._id) throw new Error('השרת לא החזיר מספר הזמנה. פנו לחנות לפני שליחת הזמנה נוספת.');
      setCheckoutResult({
        ok: true,
        order,
        message: `ההזמנה התקבלה בהצלחה. מספר ההזמנה למעקב: ${order._id}. נציגי החנות יתקשרו אליך כדי לבצע חיוב ולתאם את המשלוח.`,
      });
      setCart([]);
      setOrders((previous) => [order, ...previous.filter((item) => String(item._id) !== String(order._id))]);
      const nextIds = [String(order._id), ...trackedOrderIds.filter((id) => id !== String(order._id))].slice(0, 10);
      try { localStorage.setItem('haruzim-order-ids', JSON.stringify(nextIds)); } catch { /* tracking still works for this session */ }
      setTrackedOrderIds(nextIds);
      setStockIssue(null);
    } catch (error) {
      console.error(error);
      setCheckoutResult({ ok: false, message: error.message || 'שגיאה בשליחת ההזמנה. בדקו את החיבור ונסו שוב.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const orderStatusLabel = (order) => {
    if (order.fulfillment?.status === 'delivered') return 'נמסרה';
    if (order.fulfillment?.status === 'shipped') return 'נשלחה';
    if (order.fulfillment?.status === 'cancelled' || order.status === 'cancelled') return 'בוטלה';
    if (order.payment?.status === 'paid') return 'שולמה · ממתינה למשלוח';
    return 'התקבלה · ממתינה לתשלום';
  };

  const reorder = async (orderId) => {
    setReorderNotice('');
    try {
      const response = await fetch(`${API_BASE}/customer/orders/${orderId}/reorder`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן לשחזר את ההזמנה.');
      if (!data.available?.length) throw new Error(data.error || data.message || 'אין פריטים זמינים מההזמנה הזו.');
      setCart(data.available.map((item) => ({ ...item, category: '' })));
      setReorderNotice(data.message || data.error || 'הפריטים הזמינים נוספו לעגלה.');
      document.getElementById('cart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      setReorderNotice(error.message || 'לא ניתן לשחזר את ההזמנה.');
    }
  };

  const addOrderToTracking = (event) => {
    event.preventDefault();
    if (!customer.phone.trim()) {
      setTrackingError('יש להזין את מספר הטלפון שנמסר בהזמנה.');
      return;
    }
    const id = trackingOrderId.trim();
    if (!/^[a-f\d]{24}$/i.test(id)) {
      setTrackingError('נא להזין מספר הזמנה תקין בן 24 תווים.');
      return;
    }
    const nextIds = [id, ...trackedOrderIds.filter((existingId) => existingId !== id)].slice(0, 10);
    try { localStorage.setItem('haruzim-order-ids', JSON.stringify(nextIds)); } catch { /* tracking still works for this session */ }
    setTrackedOrderIds(nextIds);
    setTrackingOrderId('');
  };

  if (checkoutResult?.ok) {
    return <OrderConfirmation order={checkoutResult.order} onContinue={() => setCheckoutResult(null)} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Haruzim Market</p>
          <h1>מוצרים טריים, משלוח מהיר</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-btn" type="button"><Phone size={14} /> תיאום משלוח טלפוני</button>
          {account ? <button className="account-btn" type="button" onClick={signOut}><UserRound size={16} /> שלום, {account.name}<LogOut size={14} /></button> : <button className="account-btn" type="button" onClick={() => setShowAuthModal(true)}><UserRound size={16} /> התחברות</button>}
          <button className="primary-btn" type="button" onClick={() => document.getElementById('cart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><ShoppingCart size={16} /> {cart.length} פריטים</button>
        </div>
      </header>
      {isShabbatBlocked && <div className="shabbat-purchase-banner" role="status">שבת שלום — האתר סגור לרכישה כעת. אפשר לעיין במוצרים; הזמנות יחודשו במוצאי שבת.</div>}

      {featuredProduct && <section className={featuredProduct.imageUrl ? 'featured-product has-image' : 'featured-product'} aria-label="המוצר המומלץ של החנות">
        <div className="featured-copy"><span className="featured-kicker"><Sparkles size={15} /> בחירת החנות</span><h2>{featuredProduct.name}</h2><p>{featuredProduct.description || 'המוצר שהחנות בחרה להציג במיוחד בשבילכם.'}</p><div className="featured-price">{Number(featuredProduct.promotion?.price ?? featuredProduct.price).toFixed(2)}₪ <small>{featuredProduct.unitType === 'weight' ? 'לק״ג' : 'ליחידה'}</small></div><label className="catalog-quantity-control featured-quantity-control"><span>{featuredProduct.unitType === 'weight' ? 'כמות בק״ג' : 'כמות ביחידות'}</span><input type="number" min={featuredProduct.unitType === 'weight' ? '0.01' : '1'} max={featuredProduct.stockQuantity ?? undefined} step={featuredProduct.unitType === 'weight' ? '0.01' : '1'} value={featuredQuantity} onChange={(event) => setFeaturedQuantity(event.target.value)} /></label><button className="primary-btn" type="button" disabled={isShabbatBlocked || featuredProduct.stockQuantity === 0} onClick={() => addToCart(featuredProduct, featuredQuantity)}>הוספה לעגלה</button></div>
        {featuredProduct.imageUrl && <img src={featuredProduct.imageUrl} alt={featuredProduct.name} loading="eager" />}
      </section>}

      <main className="content-grid">
        {loading ? (
          <div className="catalog-panel loading-panel">
            <div className="panel-header">
              <span className="skeleton-line short" />
              <span className="skeleton-line tiny" />
            </div>
            <div className="skeleton-filter-row">
              {Array.from({ length: 5 }).map((_, idx) => (
                <span key={idx} className="skeleton-chip" />
              ))}
            </div>
            <div className="product-grid">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div key={idx} className="product-card skeleton-card">
                  <div className="skeleton-visual" />
                  <div className="product-meta">
                    <div className="skeleton-line" />
                    <div className="skeleton-line medium" />
                    <div className="skeleton-line long" />
                    <div className="skeleton-button-row">
                      <span className="skeleton-button" />
                      <span className="skeleton-button primary" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {catalogError ? (
              <section className="catalog-error-panel" role="alert" dir="rtl">
                <WifiOff size={34} aria-hidden="true" />
                <h2>לא הצלחנו לטעון את המוצרים</h2>
                <p>נראה שיש בעיה בחיבור לשרת או באינטרנט. אנא בדוק את החיבור ונסה שוב.</p>
                <button className="primary-btn" type="button" onClick={fetchCatalog}>נסה שוב</button>
              </section>
            ) : (
              <Catalog categories={categories} products={products} activeCategory={activeCategory} setActiveCategory={setActiveCategory} onSelectProduct={(product) => { setSelectedProduct(product); setSelectedProductQuantity('1'); }} onAddToCart={addToCart} isShabbatBlocked={isShabbatBlocked} />
            )}
          </>
        )}

        <Cart
          cart={cart}
          stockIssue={stockIssue}
          onChangeQuantity={updateQuantity}
          onRemove={removeFromCart}
          onCheckout={handleSubmitOrder}
          isSubmitting={isSubmitting}
          isShabbatBlocked={isShabbatBlocked}
        />
      </main>

      <section className="section-block">
        <div className="panel-header">
          <h2>ההזמנות שלי</h2>
          <span><RefreshCw size={14} /> מתעדכן אוטומטית</span>
        </div>
        {account ? <p className="account-orders-note">ההזמנות שלך שמורות בחשבון ומעודכנות אוטומטית.</p> : <p className="empty-state">הזמנות אורח ניתנות למעקב לפי טלפון; התחברות שומרת את היסטוריית ההזמנות בחשבון.</p>}
        {trackingError && <p className="tracking-error" role="alert">{trackingError}</p>}
        {!account && <form className="tracking-form" onSubmit={addOrderToTracking}>
          <label>מעקב אחר הזמנה קיימת<input value={trackingOrderId} onChange={(event) => setTrackingOrderId(event.target.value)} placeholder="מספר ההזמנה המלא" /></label>
          <button className="secondary-btn" type="submit">הוסף למעקב</button>
        </form>}
        {reorderNotice && <p className="account-orders-note" role="status">{reorderNotice}</p>}
        <div className="order-list">
          {orders.map((order) => (
            <div key={order._id} className="order-card">
              <div>
                <small>הזמנה {order._id} · {new Date(order.createdAt).toLocaleDateString('he-IL')}</small>
                <strong>{Number(order.total || 0).toFixed(2)}₪</strong>
              </div>
              <span className="status-pill">{orderStatusLabel(order)}</span>
              <small>{order.items?.length || 0} פריטים</small>
              {account && <button className="secondary-btn reorder-btn" type="button" onClick={() => reorder(order._id)}>הזמנה חוזרת</button>}
            </div>
          ))}
          {(account || customer.phone) && !orders.length && !trackingError && <p className="empty-state">עדיין אין הזמנות להצגה.</p>}
        </div>
      </section>

      <section className="payment-layout">
        <Checkout
          customer={customer}
          setCustomer={setCustomer}
          checkoutResult={checkoutResult}
          onSubmit={handleSubmitOrder}
          isSubmitting={isSubmitting}
        />

      </section>

      {selectedProduct && (
        <div className="modal-backdrop" onClick={() => setSelectedProduct(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{selectedProduct.name}</h3>
            <p>{selectedProduct.description}</p>
            <div className="modal-meta">
              <span>{selectedProduct.promotion?.price ?? selectedProduct.price}₪</span>
              <span>{selectedProduct.stockQuantity == null ? 'זמין להזמנה' : `${selectedProduct.stockQuantity} ${selectedProduct.unitType === 'weight' ? 'ק״ג במלאי' : 'יחידות במלאי'}`}</span>
            </div>
            <label className="catalog-quantity-control"><span>{selectedProduct.unitType === 'weight' ? 'כמות בק״ג' : 'כמות ביחידות'}</span><input type="number" min={selectedProduct.unitType === 'weight' ? '0.01' : '1'} max={selectedProduct.stockQuantity ?? undefined} step={selectedProduct.unitType === 'weight' ? '0.01' : '1'} value={selectedProductQuantity} onChange={(event) => setSelectedProductQuantity(event.target.value)} /></label>
            <button className="primary-btn full" type="button" disabled={isShabbatBlocked || selectedProduct.stockQuantity === 0} onClick={() => { addToCart(selectedProduct, selectedProductQuantity); setSelectedProduct(null); }}>
              הוסף לעגלה
            </button>
          </div>
        </div>
      )}
      {showAuthModal && <CustomerAuthModal onClose={() => setShowAuthModal(false)} onAuthenticated={handleAuthenticated} />}
    </div>
  );
}

export default App;
