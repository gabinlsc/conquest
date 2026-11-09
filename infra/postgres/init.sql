-- Exécuté une seule fois, à la création du volume.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- recherche de villes par nom (Phase 1)
