// Schema definition using Mongoose
const mongoose = require('mongoose');

const InstrumentDataSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    symbol: { type: String, required: true },
    name: { type: String, required: true },
    expiry: { type: String, required: true },
    strike: { type: String, required: true },
    lotsize: { type: String, required: true },
    instrumenttype: { type: String, required: true },
    exch_seg: { type: String, required: true },
    tick_size: { type: String, required: true },
  },
  { timestamps: true }
);

// Define index only on necessary fields (if required)
// Remove the generic empty object in the index method
InstrumentDataSchema.index({ token: 1 }); // Ensures efficient querying by token if needed

const InstrumentData = mongoose.model('InstrumentData', InstrumentDataSchema);

module.exports = InstrumentData;
