// Generate a bcrypt hash for a client password.
// Usage:  node hash-password.js "their-password"
import bcrypt from 'bcryptjs';
const pw = process.argv[2];
if (!pw) { console.error('Usage: node hash-password.js "password"'); process.exit(1); }
console.log(bcrypt.hashSync(pw, 10));
