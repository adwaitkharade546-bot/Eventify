import { supabase } from './lib/supabase';

async function testConnection() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .limit(1);

  if (error) {
    console.log('Supabase connection error:', error.message);
  } else {
    console.log('Supabase connected successfully!', data);
  }
}

testConnection();