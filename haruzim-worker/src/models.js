import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema({
  street: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  apartment: { type: String, trim: true }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  passwordHash: { type: String, select: false },
  googleSub: { type: String, select: false },
  role: { type: String, enum: ['customer', 'admin', 'manager'], default: 'customer' },
  addresses: [addressSchema]
}, { timestamps: true, autoIndex: false });
userSchema.index({ phone: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ googleSub: 1 }, { unique: true, sparse: true });

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  imageUrl: { type: String, trim: true, maxlength: 2000 },
  imageId: { type: String, default: null },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  price: { type: Number, required: true, min: 0 },
  unitType: { type: String, enum: ['units', 'weight'], default: 'units' },
  unitLabel: { type: String, default: 'יחידה' },
  stockQuantity: { type: Number, default: null, min: 0 },
  active: { type: Boolean, default: true },
  promotion: { label: String, price: Number }
}, { timestamps: true });
productSchema.index({ name: 'text', description: 'text' });

const productImageSchema = new mongoose.Schema({
  data: { type: String, required: true },
  contentType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  size: { type: Number, required: true, min: 1 },
  createdBy: { type: String, default: '' }
}, { timestamps: { createdAt: true, updatedAt: false } });

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },
  unitType: { type: String, enum: ['units', 'weight'], default: 'units' },
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: { type: [orderItemSchema], required: true },
  customer: { name: String, phone: String, email: String, address: addressSchema, notes: String },
  credit: { account: { type: String, ref: 'CreditAccount' }, name: String, decisionAt: Date, decisionMode: { type: String, enum: ['total', 'custom', 'skip'] }, amountCents: Number },
  subtotal: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  payment: {
    provider: { type: String, default: 'offline' },
    transactionId: String,
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }
  },
  fulfillment: {
    status: { type: String, enum: ['pending', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
    updatedAt: { type: Date, default: Date.now }
  },
  status: {
    type: String,
    enum: ['pending_payment', 'pending', 'preparing', 'shipped', 'delivered', 'cancelled', 'out_for_delivery', 'completed'],
    default: 'pending_payment'
  }
}, { timestamps: true });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1, _id: -1 });

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'manager'], default: 'manager' },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const storefrontConfigSchema = new mongoose.Schema({
  _id: { type: String, default: 'storefront' },
  featuredProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null }
}, { timestamps: true });

const creditAccountSchema = new mongoose.Schema({
  _id: { type: String },
  name: { type: String, required: true, maxlength: 80 },
  passwordHash: { type: String, required: true, select: false },
  active: { type: Boolean, default: true },
  balanceCents: { type: Number, default: 0, validate: Number.isSafeInteger },
  version: { type: Number, default: 0 },
  createdBy: String
}, { timestamps: true, autoIndex: false });
const creditEntrySchema = new mongoose.Schema({
  _id: String,
  account: { type: String, ref: 'CreditAccount', required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  kind: { type: String, enum: ['created', 'credentials', 'access', 'delivery', 'set', 'reset'], required: true },
  deltaCents: { type: Number, required: true, validate: Number.isSafeInteger },
  beforeCents: { type: Number, required: true, validate: Number.isSafeInteger },
  afterCents: { type: Number, required: true, validate: Number.isSafeInteger },
  reason: { type: String, maxlength: 300 },
  actorId: { type: String, required: true }
}, { timestamps: { createdAt: true, updatedAt: false }, autoIndex: false });

export function registerModelsOn(connection) {
  return {
    CreditAccount: connection.model('CreditAccount', creditAccountSchema),
    CreditEntry: connection.model('CreditEntry', creditEntrySchema),
    User: connection.model('User', userSchema),
    Category: connection.model('Category', categorySchema),
    Product: connection.model('Product', productSchema),
    ProductImage: connection.model('ProductImage', productImageSchema),
    Order: connection.model('Order', orderSchema),
    Admin: connection.model('Admin', adminSchema),
    StorefrontConfig: connection.model('StorefrontConfig', storefrontConfigSchema)
  };
}
