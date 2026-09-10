require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey && !supabaseUrl.includes("your-project")) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey, {
            auth: { persistSession: false }
        });
        console.log("Supabase client initialized successfully.");
    } catch (err) {
        console.warn("Supabase initialization error:", err.message);
    }
} else {
    console.log("Supabase not configured or using placeholders. Database features will run in mock/local mode until credentials are set in .env.");
}

/**
 * Check if Supabase connection is active
 */
function isConfigured() {
    return supabase !== null;
}

/**
 * Get curated / pinned media sources from Supabase
 */
async function getPinnedSources(tmdbId, mediaType = "movie", season = null, episode = null) {
    if (!supabase) return [];

    try {
        let query = supabase
            .from("media_sources")
            .select("*")
            .eq("tmdb_id", String(tmdbId))
            .eq("media_type", mediaType);

        if (mediaType === "tv") {
            if (season !== null) query = query.eq("season", Number(season));
            if (episode !== null) query = query.eq("episode", Number(episode));
        }

        const { data, error } = await query.order("priority", { ascending: false });
        if (error) {
            console.warn("Supabase getPinnedSources error:", error.message);
            return [];
        }

        return (data || []).map((s) => ({
            infoHash: s.info_hash,
            magnetUrl: s.magnet_url,
            label: s.title || `Curated Source (${s.quality || "HD"})`,
            quality: s.quality || "1080p",
            fileIdx: s.file_idx,
            isCurated: true,
            priority: s.priority
        }));
    } catch (err) {
        console.warn("Supabase query exception:", err.message);
        return [];
    }
}

/**
 * Add or override a media source in Supabase
 */
async function addMediaSource(source) {
    if (!supabase) {
        return { success: false, error: "Supabase not configured in .env" };
    }

    try {
        const { data, error } = await supabase
            .from("media_sources")
            .upsert({
                tmdb_id: String(source.tmdbId),
                media_type: source.mediaType || "movie",
                season: source.season ? Number(source.season) : null,
                episode: source.episode ? Number(source.episode) : null,
                title: source.title || null,
                magnet_url: source.magnetUrl,
                info_hash: source.infoHash.toLowerCase(),
                quality: source.quality || "1080p",
                file_idx: source.fileIdx !== undefined ? Number(source.fileIdx) : null,
                priority: source.priority ? Number(source.priority) : 10,
                verified: true,
                notes: source.notes || null,
                updated_at: new Date().toISOString()
            })
            .select();

        if (error) throw error;
        return { success: true, data: data[0] };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Delete a media source by ID
 */
async function deleteMediaSource(id) {
    if (!supabase) return { success: false, error: "Supabase not configured" };

    try {
        const { error } = await supabase.from("media_sources").delete().eq("id", id);
        if (error) throw error;
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Save user watch progress
 */
async function saveWatchProgress(progress) {
    if (!supabase) return { success: false, note: "Offline mode" };

    try {
        const { error } = await supabase
            .from("watch_history")
            .upsert({
                client_id: progress.clientId || "default_user",
                tmdb_id: String(progress.tmdbId),
                media_type: progress.mediaType || "movie",
                title: progress.title || null,
                poster_path: progress.posterPath || null,
                season: progress.season ? Number(progress.season) : null,
                episode: progress.episode ? Number(progress.episode) : null,
                episode_name: progress.episodeName || null,
                progress_seconds: Number(progress.progressSeconds || 0),
                duration_seconds: Number(progress.durationSeconds || 0),
                completed: Boolean(progress.completed),
                updated_at: new Date().toISOString()
            }, {
                onConflict: "client_id,tmdb_id,media_type,season,episode"
            });

        if (error) throw error;
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Fetch watch history
 */
async function getWatchHistory(clientId = "default_user") {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from("watch_history")
            .select("*")
            .eq("client_id", clientId)
            .order("updated_at", { ascending: false })
            .limit(50);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.warn("getWatchHistory error:", err.message);
        return [];
    }
}

/**
 * Log server metrics
 */
async function logServerMetrics(metrics) {
    if (!supabase) return;

    try {
        await supabase.from("server_metrics").insert({
            server_name: metrics.serverName || "primary_streamer",
            active_torrents: metrics.activeTorrents || 0,
            active_peers: metrics.activePeers || 0,
            download_speed_kb: metrics.downloadSpeedKb || 0,
            upload_speed_kb: metrics.uploadSpeedKb || 0,
            active_transcodes: metrics.activeTranscodes || 0,
            system_memory_mb: metrics.systemMemoryMb || 0,
            recorded_at: new Date().toISOString()
        });
    } catch (err) {
        // Silently ignore background metric errors
    }
}

/**
 * Sign in admin user with Supabase Auth
 */
async function signInAdmin(email, password) {
    if (!supabase) throw new Error("Supabase is not configured");
    const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim()
    });
    if (error) throw error;
    return data;
}

/**
 * Register a new admin user with Supabase Auth (auto-confirmed)
 */
async function registerAdmin(email, password) {
    if (!supabase) throw new Error("Supabase is not configured");
    const { data, error } = await supabase.auth.admin.createUser({
        email: email.trim(),
        password: password.trim(),
        email_confirm: true
    });
    if (error) throw error;
    return data;
}

/**
 * Verify a Supabase JWT access token
 */
async function verifyUserToken(token) {
    if (!supabase || !token) return null;
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return null;
        return user;
    } catch (e) {
        return null;
    }
}

/**
 * Check total number of registered users in Supabase
 */
async function getUserCount() {
    if (!supabase) return 0;
    try {
        const { data, error } = await supabase.auth.admin.listUsers();
        if (error || !data) return 0;
        return data.users.length;
    } catch (e) {
        return 0;
    }
}

module.exports = {
    isConfigured,
    getPinnedSources,
    addMediaSource,
    deleteMediaSource,
    saveWatchProgress,
    getWatchHistory,
    logServerMetrics,
    signInAdmin,
    registerAdmin,
    verifyUserToken,
    getUserCount
};
