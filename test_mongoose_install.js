
import mongoose from 'mongoose';
try {
    console.log('Mongoose imported successfully. Version:', mongoose.version);
} catch (e) {
    console.error('Failed to import mongoose:', e);
    process.exit(1);
}
