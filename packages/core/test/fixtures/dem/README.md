# DEM fixture tiles

Terrarium elevation tiles for the elevation tests and golden snapshots, laid out as
`{z}/{x}/{y}.png` like the tile server. Nothing here is fetched at test time: the fixture provider
(`test/support/dem.ts`) reads these files and fails on any tile that is missing.

**Provenance:** downloaded unchanged on 2026-11-14 from the AWS Open Data Terrain Tiles bucket,
`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (Mapzen Terrarium
encoding: elevation is `R * 256 + G + B / 256 - 32768` meters; in the US the source is USGS 3DEP).
Terrain Tiles are open data; see the [attribution
requirements](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

**Coverage:** zoom 12 (the provider's default, about 28 m per pixel here), the 2x2 block around
Ithaca, NY. That covers every fixture course near Ithaca: all hand-made and synthetic files plus
`FH-Fox`, `Freeville-Fly-In`, `Lakefront-Loops-5K`, `dodge` and `forest_home`. The marathons
(`boston`, `newyork`, `wineglass`) and `scurve` (Massachusetts) are left out to keep the folder
small (about 100 KB per tile, and a marathon needs 7 to 16); they have sane GPS elevation, so the
source policy never asks the DEM for them, and a test checks that.

| Tile               | Covers                                         | SHA-256                                                            |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| `12/1177/1512.png` | North of Ithaca, west (Freeville course, part) | `ab02c1f2b98fdb786ae03e006248f9d01808efddaae25528264e8cd8e2d69595` |
| `12/1177/1513.png` | Ithaca, west: downtown, Cayuga Lake shore      | `65e8f0a4e4fbc23ed4f253ea56ce166e36468ebb39495b6d4a36b30bda6a00ea` |
| `12/1178/1512.png` | North of Ithaca, east (Freeville)              | `17b813664ba49d33879518bf017ee150cb994279d0c708cb9c5c1fc4fff2e2cb` |
| `12/1178/1513.png` | Ithaca, east: Cornell, Forest Home, Dodge      | `55232d0bff9f508e2b3785e7c045733845c69368f588c74c75e4a9e4ee1765aa` |

To add a tile, download it from the URL above into the same layout and add a row here.
