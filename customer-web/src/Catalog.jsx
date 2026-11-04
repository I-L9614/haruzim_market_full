import { useState } from 'react';
import { Plus, Search, X } from 'lucide-react';

function formatPrice(value) {
  return Number(value || 0).toFixed(2);
}

export default function Catalog({
  categories,
  products,
  activeCategory,
  setActiveCategory,
  onSelectProduct,
  onAddToCart,
  isShabbatBlocked = false
}) {
  const [quantities, setQuantities] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase('he-IL');
  const visibleProducts = products.filter((product) => {
    const categoryId = String(product.category?._id || product.category);
    const categoryName = product.category?.name || categories.find((category) => String(category._id) === categoryId)?.name || '';
    const matchesCategory = activeCategory === 'all' || categoryId === String(activeCategory);
    const matchesQuery = !normalizedQuery
      || String(product.name || '').toLocaleLowerCase('he-IL').includes(normalizedQuery)
      || String(categoryName).toLocaleLowerCase('he-IL').includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });

  return (
    <section className="catalog-panel">
      <div className="panel-header">
        <h2>קטלוג</h2>
        <span>{visibleProducts.length} מוצרים</span>
      </div>

      <label className="catalog-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="חיפוש לפי שם מוצר או קטגוריה"
          aria-label="חיפוש לפי שם מוצר או קטגוריה"
        />
        {searchQuery && <button type="button" onClick={() => setSearchQuery('')} aria-label="ניקוי החיפוש"><X size={16} /></button>}
      </label>

      <div className="category-strip">
        <button className={activeCategory === 'all' ? 'chip active' : 'chip'} onClick={() => setActiveCategory('all')}>
          הכול
        </button>
        {categories.map((category) => (
          <button
            key={category._id}
            className={activeCategory === String(category._id) ? 'chip active' : 'chip'}
            onClick={() => setActiveCategory(String(category._id))}
          >
            {category.name}
          </button>
        ))}
      </div>

      <div className="product-grid">
        {visibleProducts.map((product) => {
          const productId = String(product._id);
          const isWeightProduct = product.unitType === 'weight';
          const quantity = quantities[productId] ?? '1';
          const displayPrice = product.promotion?.price ?? product.price;
          const unitLabel = product.unitType === 'weight' ? (product.unitLabel || 'ק"ג') : 'יחידה';
          const stockLabel = product.stockQuantity == null
            ? 'זמין להזמנה'
            : `${product.stockQuantity} ${isWeightProduct ? 'ק״ג במלאי' : 'יחידות במלאי'}`;

          return (
            <article key={product._id} className="product-card">
              <div className="product-image">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : (product.name?.slice(0, 2) || 'מ')}</div>
              <div className="product-meta">
                <div className="tag-row">
                  <span className="tag">{unitLabel}</span>
                  {product.promotion && <span className="promo">מבצע</span>}
                </div>
                <h3>{product.name}</h3>
                <p>{product.description}</p>
                <div className="price-row">
                  <strong>{formatPrice(displayPrice)}₪ <small>{isWeightProduct ? '/ ק״ג' : '/ יח׳'}</small></strong>
                  <span>{stockLabel}</span>
                </div>
                <label className="catalog-quantity-control">
                  <span>{isWeightProduct ? 'כמות בק״ג' : 'כמות ביחידות'}</span>
                  <input
                    type="number"
                    min={isWeightProduct ? '0.01' : '1'}
                    max={product.stockQuantity ?? undefined}
                    step={isWeightProduct ? '0.01' : '1'}
                    value={quantity}
                    aria-label={`${isWeightProduct ? 'משקל בקילוגרמים' : 'כמות ביחידות'} עבור ${product.name}`}
                    onChange={(event) => setQuantities((previous) => ({ ...previous, [productId]: event.target.value }))}
                  />
                </label>
                <div className="card-actions">
                  <button className="secondary-btn" onClick={() => onSelectProduct(product)}>פרטים</button>
                  <button className="primary-btn" onClick={() => onAddToCart(product, Number(quantity))} disabled={isShabbatBlocked || product.stockQuantity === 0}>
                    <Plus size={14} /> הוסף לסל
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        {!visibleProducts.length && <p className="empty-state">לא נמצאו מוצרים להצגה כרגע.</p>}
      </div>
    </section>
  );
}
