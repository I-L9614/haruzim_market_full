const mongoose = require('mongoose');

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
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  price: { type: Number, required: true, min: 0 },
  unitType: { type: String, enum: ['units', 'weight'], default: 'units' },
  unitLabel: { type: String, default: 'יחידה' },
  stockQuantity: { type: Number, default: null, min: 0 },
  active: { type: Boolean, default: true },
  promotion: { label: String, price: Number }
}, { timestamps: true });
productSchema.index({ name: 'text', description: 'text' });

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

module.exports = {
  User: mongoose.model('User', userSchema),
  Category: mongoose.model('Category', categorySchema),
  Product: mongoose.model('Product', productSchema),
  Order: mongoose.model('Order', orderSchema),
  Admin: mongoose.model('Admin', adminSchema),
  StorefrontConfig: mongoose.model('StorefrontConfig', storefrontConfigSchema)
};
