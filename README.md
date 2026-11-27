# The World Today — Friday 27 November 2026

[![make.fun](https://make.fun/badge/news-image-20261127.svg)](https://make.fun/bounty/news-image-20261127)
[![rank](https://make.fun/badge/news-image-20261127/aam110/makefun-news-image-20261127/rank.svg)](https://make.fun/bounty/news-image-20261127)
[![reward](https://make.fun/badge/news-image-20261127/aam110/makefun-news-image-20261127/reward.svg)](https://make.fun/bounty/news-image-20261127)

One day's world news in one image: **Friday 27 November 2026**, drawn as a
newspaper front page. Entry for the [make.fun bounty
news-image-20261127](https://make.fun/bounty/news-image-20261127).

## What the page shows

**36 stories, all verified as 27 November 2026** — each one checked against live
news reporting before it was drawn, with its outlet and a label (OFFICIAL,
CONFIRMED, REPORTED, ONGOING, SCHEDULED):

- **Hero 1 — the diagram:** New Zealand counts ~400,000 special votes. The
  preliminary parliament (National 42, Labour 36, Greens 16, ACT 13, NZ First
  12, Opportunity 7, Te Pāti Māori 5) leaves the coalition on 67 of 131 seats —
  one more than the 66 needed to govern. Official count due 14:00 NZDT.
- **Hero 2 — the data chart:** Tokyo core CPI quickens to **+2.9%** year on
  year, up from 2.6% in October and above the Bank of Japan's 2% target for a
  third straight month.
- **Hero 3 — the scene:** Macy's crews re-inflate the giant balloons on
  Friday afternoon for the rescheduled 100th Thanksgiving Day Parade on
  Saturday 28 November.
- **The day in ten:** Seoul guesthouse fire, North Korean troops crossing the
  demarcation line 40 times, Australia's 20% gas reservation, JERA's data
  centre talks with Anthropic and Meta, the Bank of Korea's AI warning, the
  Pakistan–Saudi–Turkey meeting in Islamabad, a damning DFAT sanctions audit,
  Singapore's 1.55-month civil service bonus, the RNZ cyber breach probe, and
  Qatar GP practice at Lusail.
- **Where it happened:** a world map with 13 numbered places, a six-point UTC
  timeline, and 23 more stories in brief.
- **Date check:** ten big stories that are *not* 27 November (Kuwait, Gukesh
  game 3, Gaza, UK migration, Ebola, Nepal, the Ibiza tanker, the GDP probe,
  Depardieu, the Bangkok refinery) are boxed in red so they are never mistaken
  for today's news.

Scenes are drawn illustrations, not photographs. Sources: Reuters, NZ Herald,
The Hindu, Sydney Morning Herald, Straits Times, Korea JoongAng Daily, Aju
Press, CNN, Formula1.com, Mint, Hindustan Times, Times of India.

## How it is built

`main.ts` (Node 22, standard library only) draws the whole page itself: its
own PNG encoder, its own text rasteriser, and real serif type — Noto Serif
Display Black for the masthead, Liberation Serif for the body — from font
outlines embedded in `glyphs.bin` (extracted from the OFL fonts with
fontTools). No network, no dependencies, deterministic: two runs produce a
byte-identical image.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes one 1024×1024 PNG under 1 MiB to `out/entry.png`.

## Licence

MIT — see [LICENSE](LICENSE).
