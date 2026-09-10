import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('your-project')
);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * Save user watch progress to Supabase
 */
export async function syncWatchProgress({ tmdbId, mediaType, title, posterPath, season, episode, episodeName, progressSeconds, durationSeconds, completed }) {
  if (!supabase) {
    // Fallback to localStorage
    const localKey = `viewlix_resume_${mediaType}_${tmdbId}${season ? `_${season}_${episode}` : ''}`;
    try {
      localStorage.setItem(localKey, JSON.stringify({
        progressSeconds,
        durationSeconds,
        timestamp: Date.now()
      }));
    } catch (e) {}
    return;
  }

  try {
    await supabase.from('watch_history').upsert({
      client_id: 'default_user',
      tmdb_id: String(tmdbId),
      media_type: mediaType || 'movie',
      title: title || null,
      poster_path: posterPath || null,
      season: season ? Number(season) : null,
      episode: episode ? Number(episode) : null,
      episode_name: episodeName || null,
      progress_seconds: Math.round(progressSeconds),
      duration_seconds: Math.round(durationSeconds),
      completed: Boolean(completed),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'client_id,tmdb_id,media_type,season,episode'
    });
  } catch (err) {
    console.warn('Failed to sync watch progress to Supabase:', err);
  }
}

/**
 * Fetch watch history
 */
export async function getWatchHistory() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('watch_history')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('Error fetching watch history:', e);
    return [];
  }
}
