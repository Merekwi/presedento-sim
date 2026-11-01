# Presidential Simulator visual assets

- `flags.svg`: locally bundled vector flags for all 20 currently playable countries in the database.
- `portraits.svg`: 16 original fictional illustrated presidential/cabinet portraits with varied skin tones, hairstyles and presentation. They do not depict real people.
- The interactive world and military maps use the bundled Natural Earth GeoJSON dataset (`world-countries.geojson`). The frontend loads it from the same origin first, then retries through jsDelivr and GitHub Raw if the local request fails. Source: https://github.com/topojson/world-atlas
- Country flag artwork is simplified vector artwork intended for game UI, not official reproduction masters.
