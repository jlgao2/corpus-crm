/**
 * Idempotent schema setup for the photos layer.
 *
 * All tables use CREATE TABLE IF NOT EXISTS so this is safe to call multiple
 * times. Called by build-photos.js at the start of every run.
 */

export async function ensurePhotoSchema(conn) {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id              VARCHAR PRIMARY KEY,
      ts              BIGINT NOT NULL,
      ts_iso          VARCHAR,
      source          VARCHAR NOT NULL,
      source_ref      VARCHAR,
      message_id      VARCHAR,
      asset_path      VARCHAR,
      width           INTEGER,
      height          INTEGER,
      hash_sha256     VARCHAR,
      has_named_face  BOOLEAN
    );
    CREATE INDEX IF NOT EXISTS idx_photos_ts          ON photos(ts);
    CREATE INDEX IF NOT EXISTS idx_photos_hash        ON photos(hash_sha256);
    CREATE INDEX IF NOT EXISTS idx_photos_message     ON photos(message_id);

    CREATE TABLE IF NOT EXISTS photo_faces (
      photo_id        VARCHAR NOT NULL,
      canonical_id    VARCHAR NOT NULL,
      face_cluster    VARCHAR,
      PRIMARY KEY (photo_id, canonical_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pf_photo     ON photo_faces(photo_id);
    CREATE INDEX IF NOT EXISTS idx_pf_canonical ON photo_faces(canonical_id);

    CREATE TABLE IF NOT EXISTS places (
      photo_id        VARCHAR PRIMARY KEY,
      lat             DOUBLE,
      lng             DOUBLE,
      place_name      VARCHAR,
      city            VARCHAR,
      region          VARCHAR,
      country         VARCHAR
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id        VARCHAR PRIMARY KEY,
      start_ts        BIGINT NOT NULL,
      end_ts          BIGINT NOT NULL,
      place_name      VARCHAR,
      participants    VARCHAR[],
      n_photos        INTEGER,
      n_messages      INTEGER,
      summary         VARCHAR
    );
    -- source: 'photos' (clustered from the photo corpus) | 'messages'
    -- (meetups inferred from message evidence). Kept as a separate ALTER so
    -- DBs whose events table predates the column pick it up too.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS source VARCHAR;
    -- Geotag: photo events store their GPS cluster center; inferred meetups
    -- store the forward-geocoded venue when the LLM named one.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS lat DOUBLE;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS lng DOUBLE;

    CREATE TABLE IF NOT EXISTS event_photos (
      event_id        VARCHAR NOT NULL,
      photo_id        VARCHAR NOT NULL,
      PRIMARY KEY (event_id, photo_id)
    );

    CREATE TABLE IF NOT EXISTS event_messages (
      event_id        VARCHAR NOT NULL,
      message_id      VARCHAR NOT NULL,
      PRIMARY KEY (event_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS reverse_geocode_cache (
      lat_round       DOUBLE,
      lng_round       DOUBLE,
      place_name      VARCHAR,
      city            VARCHAR,
      region          VARCHAR,
      country         VARCHAR,
      PRIMARY KEY (lat_round, lng_round)
    );

    CREATE TABLE IF NOT EXISTS photo_face_dets (
      det_id       VARCHAR PRIMARY KEY,
      photo_id     VARCHAR NOT NULL,
      bbox         VARCHAR,
      det_score    DOUBLE,
      cluster_id   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pfd_photo   ON photo_face_dets(photo_id);
    CREATE INDEX IF NOT EXISTS idx_pfd_cluster ON photo_face_dets(cluster_id);

    CREATE TABLE IF NOT EXISTS face_clusters (
      cluster_id          INTEGER PRIMARY KEY,
      n_faces             INTEGER,
      canonical_id        VARCHAR,
      label               VARCHAR,
      exemplar_photo_ids  VARCHAR[]
    );
  `);
}
