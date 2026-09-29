const fs = require('fs');
const path = require('path');

const LECTURES = [
  { id: '12.1', slug: 'lecture-12-1-overview', title: 'Overview' },
  { id: '12.2', slug: 'lecture-12-2-bull-call-spread', title: 'Bull Call Spread' },
  { id: '12.3', slug: 'lecture-12-3-bear-call-spread', title: 'Bear Call Spread' },
  { id: '12.4', slug: 'lecture-12-4-bear-put-spread', title: 'Bear Put Spread' },
  { id: '12.5', slug: 'lecture-12-5-bull-put-spread', title: 'Bull Put Spread' },
  { id: '12.6', slug: 'lecture-12-6-covered-call', title: 'Covered Call' },
  { id: '12.7', slug: 'lecture-12-7-cash-secured-put', title: 'Cash Secured Put' },
  { id: '12.8', slug: 'lecture-12-8-long-straddle', title: 'Long Straddle' },
  { id: '12.9', slug: 'lecture-12-9-short-straddle', title: 'Short Straddle' },
  { id: '12.10', slug: 'lecture-12-10-strangle-long-and-short', title: 'Strangle (Long and Short)' },
  { id: '12.11', slug: 'lecture-12-11-back-spread-and-front-spread-with-calls', title: 'Back Spread and Front Spread (With Calls)' },
  { id: '12.12', slug: 'lecture-12-12-back-spread-and-front-spread-with-puts', title: 'Back Spread and Front Spread (With Puts)' },
  { id: '12.13', slug: 'lecture-12-13-condor-w-calls-w-puts-and-iron-condors', title: 'Condor (/w Calls, /w Puts, and Iron Condors)' },
  { id: '12.14', slug: 'lecture-12-14-butterfly-w-calls-w-puts-and-iron-butterflies', title: 'Butterfly (/w Calls, /w Puts, and Iron Butterflies)' },
  { id: '12.15', slug: 'lecture-12-15-risk-reversals-and-collars', title: 'Risk Reversals (and Collars)' },
  { id: '12.16', slug: 'lecture-12-16-synthetic-positions', title: 'Synthetic Positions' },
];

const BASE_URL = 'https://insights.deribit.com/options-course/sections/section-12-strategies-and-combinations/options-course/lectures/';
const OUT_DIR = path.join(__dirname, '..', 'data', 'deribit_course_section_12');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function cleanHtmlToMarkdown(html) {
  // Extract main content between ld-tab-content and ld-tabs-content
  const tabContentMatch = html.match(/<div[^>]*class="[^"]*ld-tab-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--\/\.ld-tabs-content-->/i)
    || html.match(/<div[^>]*class="[^"]*ld-tab-content[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*learndash-wrapper[^"]*ld_navigation/i)
    || html.match(/<div class="post-content">([\s\S]*?)<\/div>\s*<\/article>/i);

  let raw = tabContentMatch ? tabContentMatch[1] : html;

  // Replace headings
  raw = raw.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  raw = raw.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  raw = raw.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  raw = raw.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');

  // Replace images
  raw = raw.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '![]($1)\n\n');

  // Replace lists
  raw = raw.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  raw = raw.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Replace paragraphs and line breaks
  raw = raw.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  raw = raw.replace(/<br\s*[\/]?>/gi, '\n');

  // Strip remaining HTML tags
  raw = raw.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  raw = raw.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  raw = raw.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  raw = raw.replace(/<[^>]+>/g, '');

  // Unescape HTML entities
  raw = raw.replace(/&amp;/g, '&')
           .replace(/&lt;/g, '<')
           .replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"')
           .replace(/&#8211;/g, '–')
           .replace(/&#8212;/g, '—')
           .replace(/&#8217;/g, "'")
           .replace(/&#8220;/g, '"')
           .replace(/&#8221;/g, '"')
           .replace(/&#038;/g, '&')
           .replace(/&nbsp;/g, ' ');

  // Clean excessive blank lines
  raw = raw.replace(/\n{3,}/g, '\n\n').trim();
  return raw;
}

async function scrapeAll() {
  console.log(`Starting crawl of ${LECTURES.length} lectures from Deribit Section 12...`);
  const summaryList = [];

  for (const lec of LECTURES) {
    const url = `${BASE_URL}${lec.slug}/`;
    console.log(`Fetching Lecture ${lec.id}: ${lec.title}...`);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!resp.ok) {
        console.error(`Failed to fetch ${url}: status ${resp.status}`);
        continue;
      }
      const html = await resp.text();
      const mdContent = cleanHtmlToMarkdown(html);

      const filePath = path.join(OUT_DIR, `${lec.slug}.md`);
      const fileHeader = `# Lecture ${lec.id}: ${lec.title}\n\n**Source URL**: ${url}\n\n---\n\n`;
      fs.writeFileSync(filePath, fileHeader + mdContent, 'utf-8');
      console.log(`Saved -> ${filePath} (${mdContent.length} bytes)`);

      summaryList.push({
        id: lec.id,
        title: lec.title,
        slug: lec.slug,
        length: mdContent.length,
        url
      });

      // Brief delay to be polite
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error(`Error crawling ${lec.slug}:`, err.message);
    }
  }

  // Generate Master Summary
  const summaryMd = `# Deribit Options Course - Section 12: Strategies & Combinations Knowledge Corpus

Captured on: ${new Date().toISOString()}
Total Lectures: ${summaryList.length}

## Table of Lectures
${summaryList.map(s => `- **Lecture ${s.id}**: [${s.title}](./${s.slug}.md) (${s.length} chars)`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'INDEX.md'), summaryMd, 'utf-8');
  console.log(`Done! Crawled ${summaryList.length} lectures successfully.`);
}

scrapeAll();
