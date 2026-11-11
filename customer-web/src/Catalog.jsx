import { useState } from 'react';
import { Search, X } from 'lucide-react';

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

  const quantityStep = (product) => (product.unitType === 'weight' ? 0.5 : 1);
  const quantityMinimum = (product) => (product.unitType === 'weight' ? 0.5 : 1);

  const adjustQuantity = (product, direction) => {
    const productId = String(product._id);
    const step = quantityStep(product);
    const minimum = quantityMinimum(product);
    setQuantities((previous) => {
      const current = Number(previous[productId] ?? '1');
      let next = Number.isFinite(current) ? current + direction * step : minimum;
      next = Math.round(next * 100) / 100;
      if (next < minimum) next = minimum;
      return { ...previous, [productId]: String(next) };
    });
  };

  const stockChipFor = (product, isWeightProduct) => {
    return { label: product.active === false ? 'חסר במלאי' : 'זמין להזמנה', low: product.active === false };
  };

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
          const chip = stockChipFor(product, isWeightProduct);

          return (
            <article key={product._id} className="product-card">
              <button type="button" className="product-image product-image-btn" onClick={() => onSelectProduct(product)} aria-label={`פרטים נוספים על ${product.name}`}>
                {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <span aria-hidden="true">{product.name?.slice(0, 2) || 'מ'}</span>}
                {product.promotion && <span className="promo img-promo">מבצע</span>}
                <span className="unit-tag">{isWeightProduct ? 'לק״ג' : 'ליחידה'}</span>
              </button>
              <div className="product-meta">
                <h3><button type="button" className="product-name-btn" onClick={() => onSelectProduct(product)} aria-label={`פרטים נוספים על ${product.name}`}>{product.name}</button></h3>
                <p className="product-desc">{product.description}</p>
                <div className="price-row">
                  <strong>{formatPrice(displayPrice)}₪ <small>{isWeightProduct ? '/ ק״ג' : '/ יח׳'}</small></strong>
                  {product.promotion && <span className="price-old">{formatPrice(product.price)}₪</span>}
                </div>
                <span className={chip.low ? 'stock-chip low' : 'stock-chip'}>{chip.label}</span>
                <div className="buy-row">
                  <div className="qty-stepper" role="group" aria-label={`בחירת כמות עבור ${product.name}`}>
                    <button type="button" aria-label="הוסף" disabled={isShabbatBlocked} onClick={() => adjustQuantity(product, 1)}>+</button>
                    <span className="qty-value">{quantity} <span className="qty-unit">{isWeightProduct ? 'ק״ג' : 'יח׳'}</span></span>
                    <button type="button" aria-label="הפחת" disabled={isShabbatBlocked} onClick={() => adjustQuantity(product, -1)}>−</button>
                  </div>
                  <button className="add-btn" type="button" onClick={() => onAddToCart(product, Number(quantity))} disabled={isShabbatBlocked || product.active === false}>
                    הוסף לסל
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
