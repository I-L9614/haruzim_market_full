const { User } = require('../src/models');

async function ensureCustomerIndexes() {
  const collection = User.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
  }

  const phoneIndex = indexes.find((index) => index.key?.phone === 1);
  if (phoneIndex && (!phoneIndex.unique || !phoneIndex.sparse)) {
    await collection.dropIndex(phoneIndex.name);
  }

  const duplicateEmails = await collection.aggregate([
    { $match: { email: { $type: 'string' } } },
    {
      $group: {
        _id: { $toLower: '$email' },
        accounts: { $push: { id: '$_id', hasPassword: { $ne: [{ $ifNull: ['$passwordHash', null] }, null] }, hasGoogle: { $ne: [{ $ifNull: ['$googleSub', null] }, null] } } },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  const cleanup = [];
  for (const group of duplicateEmails) {
    const authenticated = group.accounts.filter((account) => account.hasPassword || account.hasGoogle);
    if (authenticated.length > 1) {
      throw new Error('Multiple authenticated customer accounts share an email. Resolve duplicate customer accounts before starting the service.');
    }
    const keepId = authenticated[0]?.id;
    for (const account of group.accounts) {
      if (!keepId || String(account.id) !== String(keepId)) {
        cleanup.push({ updateOne: { filter: { _id: account.id }, update: { $unset: { email: 1 } } } });
      }
    }
  }
  if (cleanup.length) await collection.bulkWrite(cleanup);

  await collection.createIndex({ phone: 1 }, { name: 'phone_1', unique: true, sparse: true });
  await collection.createIndex({ email: 1 }, {
    name: 'email_1',
    unique: true,
    partialFilterExpression: { email: { $type: 'string' } }
  });
  await collection.createIndex({ googleSub: 1 }, { name: 'googleSub_1', unique: true, sparse: true });
}

module.exports = { ensureCustomerIndexes };
