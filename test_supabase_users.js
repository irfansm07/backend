require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  console.log('Querying Supabase users table...');
  const { data, error } = await supabase.from('users').select('id, username, email, college').limit(10);
  if (error) {
    console.error('Error fetching users:', error);
  } else {
    console.log('Fetched users:', data);
  }
}

check().catch(console.error);
