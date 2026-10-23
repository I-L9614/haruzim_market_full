import { AlertCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';

export default function Cart({ cart, stockIssue, onChangeQuantity, onRemove, onCheckout, isSubmitting, isShabbatBlocked }) {
  const [quantityDrafts, setQuantityDrafts] = useState({});
  const cartTotal = cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);

  const commitQuantity = (productId) => {
    if (quantityDrafts[productId] !== undefined) onChangeQuantity(productId, quantityDrafts[productId]);
    setQuantityDrafts((previous) => {
      const next = { ...previous };
      delete next[productId];
      return next;
    });
  };

  return (
    <aside className="sidebar-panel" id="cart-panel">
      <div className="panel-header">
        <h2>העגלה</h2>
        <span>{cartTotal.toFixed(2)}₪</span>
      </div>

      <div className="cart-list">
        {cart.length ? (
          cart.map((item) => (
            <div key={item.productId} className="cart-item">
              <div>
                <strong>{item.name}</strong>
                <small>{Number(item.price).toFixed(2)}₪ {item.unitType === 'weight' ? '/ ק״ג' : '/ יח׳'}</small>
              </div>
              <div className="qty-box">
                <input
                  className="cart-quantity-input"
                  type="number"
                  min={item.unitType === 'weight' ? '0.01' : '1'}
                  max={item.stockQuantity ?? undefined}
                  step={item.unitType === 'weight' ? '0.01' : '1'}
                  value={quantityDrafts[item.productId] ?? String(item.quantity)}
                  aria-label={`${item.unitType === 'weight' ? 'משקל בקילוגרמים' : 'כמות ביחידות'} עבור ${item.name}`}
                  disabled={isShabbatBlocked}
                  onChange={(event) => setQuantityDrafts((previous) => ({ ...previous, [item.productId]: event.target.value }))}
                  onBlur={() => commitQuantity(item.productId)}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                />
                <span>{item.unitType === 'weight' ? 'ק״ג' : 'יח׳'}</span>
              </div>
              <button type="button" className="remove-btn" onClick={() => onRemove(item.productId)} aria-label={`הסרת ${item.name} מהעגלה`}>
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <p className="empty-state">העגלה ריקה</p>
        )}
      </div>

      {stockIssue && (
        <div className="alert-box danger">
          <AlertCircle size={16} />
          <div>
            <strong>{stockIssue.message}</strong>
            {stockIssue.missingItems?.length > 0 && (
              <ul>
                {stockIssue.missingItems.map((item) => (
                  <li key={item.productId}>
                    {item.productId} • זמינות: {item.available}
                    {item.alternatives?.length ? ` • חלופות: ${item.alternatives.map((alt) => alt.name).join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="checkout-box">
        <div className="checkout-row"><span>סה"כ</span><strong>{cartTotal.toFixed(2)}₪</strong></div>
        <button className="primary-btn full" type="button" onClick={onCheckout} disabled={!cart.length || isSubmitting || isShabbatBlocked}>{isShabbatBlocked ? 'הזמנות סגורות בשבת' : isSubmitting ? 'שולחים הזמנה…' : 'שליחת הזמנה לחנות'}</button>
      </div>
    </aside>
  );
}
