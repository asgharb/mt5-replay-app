#property strict
#property script_show_inputs

input string InpSymbol          = "";     // Symbol (empty = current chart)
input int    InpMonthsBack      = 48;      // Months back
input bool   InpExportM1        = true;
input bool   InpExportM5        = true;
input bool   InpExportM15       = true;
input bool   InpExportH1        = true;
input bool   InpExportH4        = true;
input bool   InpWriteHeader     = true;
input int    InpMaxRetries      = 12;
input int    InpRetrySleepMs    = 350;

string TfToStr(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      default:         return "TF";
   }
}

datetime MonthsAgo(datetime now, int months_back)
{
   MqlDateTime dt;
   TimeToStruct(now, dt);
   dt.mon -= months_back;
   while(dt.mon <= 0)
   {
      dt.mon += 12;
      dt.year--;
   }
   int mdays = 31;
   if(dt.mon == 4 || dt.mon == 6 || dt.mon == 9 || dt.mon == 11) mdays = 30;
   else if(dt.mon == 2)
   {
      bool leap = ((dt.year % 4 == 0 && dt.year % 100 != 0) || (dt.year % 400 == 0));
      mdays = leap ? 29 : 28;
   }
   if(dt.day > mdays) dt.day = mdays;
   return StructToTime(dt);
}

bool EnsureHistory(const string symbol, ENUM_TIMEFRAMES tf, datetime from, datetime to)
{
   ResetLastError();
   for(int i = 0; i < InpMaxRetries; i++)
   {
      MqlRates tmp[];
      int got = CopyRates(symbol, tf, from, to, tmp);
      if(got > 0) return true;
      Sleep(InpRetrySleepMs);
      ResetLastError();
   }
   return false;
}

bool ExportTF(const string symbol, ENUM_TIMEFRAMES tf, datetime from, datetime to)
{
   if(!EnsureHistory(symbol, tf, from, to))
   {
      PrintFormat("History not loaded for %s %s", symbol, TfToStr(tf));
      return false;
   }

   MqlRates rates[];
   int bars = CopyRates(symbol, tf, from, to, rates);
   if(bars <= 0)
   {
      PrintFormat("No bars copied for %s %s. err=%d", symbol, TfToStr(tf), GetLastError());
      return false;
   }

   ArraySetAsSeries(rates, false);

   string filename = StringFormat("export_%s_%s_last_%d_months_unixms.csv", symbol, TfToStr(tf), InpMonthsBack);
   int handle = FileOpen(filename, FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE)
   {
      PrintFormat("FileOpen failed: %s err=%d", filename, GetLastError());
      return false;
   }

   if(InpWriteHeader)
   {
      FileWrite(handle, "time", "open", "high", "low", "close", "tick_volume", "spread");
   }

   for(int i = 0; i < bars; i++)
   {
      long t_ms = (long)rates[i].time * 1000L;
      FileWrite(handle,
                IntegerToString(t_ms),
                DoubleToString(rates[i].open,  _Digits),
                DoubleToString(rates[i].high,  _Digits),
                DoubleToString(rates[i].low,   _Digits),
                DoubleToString(rates[i].close, _Digits),
                IntegerToString(rates[i].tick_volume),
                IntegerToString(rates[i].spread)
               );
   }

   FileClose(handle);
   PrintFormat("Exported %d bars -> %s", bars, filename);
   return true;
}

void OnStart()
{
   string symbol = (InpSymbol == "" ? _Symbol : InpSymbol);
   datetime to   = TimeCurrent();
   datetime from = MonthsAgo(to, InpMonthsBack);

   PrintFormat("Export starting: Symbol=%s, From=%s, To=%s",
               symbol,
               TimeToString(from, TIME_DATE|TIME_SECONDS),
               TimeToString(to,   TIME_DATE|TIME_SECONDS));

   int okCount = 0;
   int allCount = 0;

   if(InpExportM1)  { allCount++; if(ExportTF(symbol, PERIOD_M1,  from, to)) okCount++; }
   if(InpExportM5)  { allCount++; if(ExportTF(symbol, PERIOD_M5,  from, to)) okCount++; }
   if(InpExportM15) { allCount++; if(ExportTF(symbol, PERIOD_M15, from, to)) okCount++; }
   if(InpExportH1)  { allCount++; if(ExportTF(symbol, PERIOD_H1,  from, to)) okCount++; }
   if(InpExportH4)  { allCount++; if(ExportTF(symbol, PERIOD_H4,  from, to)) okCount++; }

   PrintFormat("Export completed: %d/%d files created in MQL5\\Files", okCount, allCount);
}
