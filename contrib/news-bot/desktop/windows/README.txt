NEWS RADAR FOR WINDOWS
======================

News Radar is a news app that runs on your own computer. It collects the news
itself, every few minutes, and shows it in its own window:

  - breaking news, world, business and markets
  - what Trump posts on Truth Social, what the Fed and the White House say
  - live market prices and odds on what could happen next
  - your own stocks, with earnings dates
  - pop-up alerts for urgent stories

It does not need GitHub, Discord or an account.


HOW TO START
------------

1. Right-click the zip file you downloaded, choose "Extract All", and extract it.
2. Open the extracted folder and double-click "News Radar.bat".
3. The first time, it downloads a small helper (Node.js, about 35 MB) and puts a
   "News Radar" icon on your desktop. This takes about a minute.
4. The News Radar window opens when the news is ready.

If Windows says "Windows protected your PC", click "More info", then "Run anyway".
That message appears for any file that was downloaded and is not from a big company.

A black window stays open in your taskbar while News Radar runs. Minimise it, but
don't close it: closing it quits News Radar. From then on, start News Radar with the
desktop icon.


WHAT YOU CAN CHANGE
-------------------

Click the gear button at the top right of the News Radar window:

  - My stocks: type stock symbols (for example AAPL, TSLA, NVDA) to get a "My
    stocks" tab with their news, and their earnings dates in the Calendar tab.
  - How often to look for news.
  - SEC filings: type your email to get filings by big investors (Berkshire,
    Pershing Square and more). The SEC asks for a contact; it is sent only to sec.gov.
  - A Discord webhook link, to also post the news to a Discord channel while News
    Radar is running.

Click the bell button to get a pop-up for each urgent story.


GOOD TO KNOW
------------

- News Radar finds news only while it is running (while the black window is open).
- Everything stays on your computer in  %LOCALAPPDATA%\NewsRadar
- It never opens a port to the internet: it listens only on this computer.


TO REMOVE IT
------------

Delete the "News Radar" icon from your desktop and delete the folder
%LOCALAPPDATA%\NewsRadar  (paste that into the File Explorer address bar).
Nothing else was installed.
