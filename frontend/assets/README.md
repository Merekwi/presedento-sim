# Presidential Simulator visual assets

- `flags.svg`: locally bundled vector flags for all 20 currently playable countries in the database.
- `portraits.svg`: 16 original fictional illustrated presidential/cabinet portraits with varied skin tones, hairstyles and presentation. They do not depict real people.
- The interactive world and military maps use Esri World Imagery satellite tiles as the basemap (`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`). The frontend overlays country boundaries, the player's country, military fronts, units, and patrol routes using the local Natural Earth GeoJSON. The map can render satellite tiles before boundary data finishes loading. Attribution: Tiles © Esri, Vantor, Earthstar Geographics, and the GIS User Community. The local Natural Earth GeoJSON loader retries through jsDelivr and GitHub Raw if the same-origin request fails. Source: https://github.com/topojson/world-atlas
- Country flag artwork is simplified vector artwork intended for game UI, not official reproduction masters.
