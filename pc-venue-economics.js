/* ====================================================================
 * pc-venue-economics.js — shared per-venue COS & labor math
 *
 * Extracted from /cos-labor/index.html on Oct 3, 2026. The formulas are
 * moved VERBATIM — the only changes are that page globals became fields
 * on a ctx object returned by load(), and the unpriced-placement tally is
 * passed in instead of living in a page global.
 *
 * One addition: labor HOURS (regular + OT) from payroll_run_venue_lines,
 * exposed as actHoursWeeks / actHoursTotal / hoursWeeksUploaded on each
 * venue's data object. COS & Labor ignores them; Business Overview uses
 * them for revenue per labor hour.
 *
 * Consumers: /cos-labor/, /business-overview/ (planned).
 * Change a formula here and both pages move together — that is the point.
 *
 * Requires (load first): /pc-auth.js, /pc-fiscal.js, /pc-roles.js
 *
 * API:
 *   pcVenueEconomics.load(period)                -> Promise<ctx>
 *   pcVenueEconomics.buildVenue(ctx, code, acc)  -> venue data object
 *   pcVenueEconomics.mergeVenues(ctx, codes, acc)-> merged data object
 *   pcVenueEconomics.calcRevenue(ctx, sale)
 *   pcVenueEconomics.resolveVenueCode(name)
 *   pcVenueEconomics.periodCountMonth(period)
 *   pcVenueEconomics.newUnpricedAcc()            -> {} tally for buildVenue
 *   pcVenueEconomics.VENUES / VENUE_FULL / VENUE_STATE / PLACEMENT_ERA_START
 * ==================================================================== */
(function (global) {
  'use strict';

  var SUPA_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var INVENTORY_SENTINEL = 'e2bf5cd1-5f50-4b11-b4b3-30c06907bffc';

  /* Placement records began 2026-04-30. Periods starting before that use
     the frozen legacy labor estimate. The cutoff never moves. */
  var PLACEMENT_ERA_START = '2026-04-30';

  var VENUES = [
    {code:'ACCC', label:'ACCC'},{code:'BWH', label:'BWH'},{code:'Mann', label:'Mann'},
    {code:'FMP', label:'FMP'},{code:'Cure', label:'Cure'},{code:'DE', label:'DE'},
    {code:'Montage', label:'Montage'},{code:'Subaru', label:'Subaru'},
    {code:'Villanova', label:'Villanova'},{code:'SATB', label:'SATB'},{code:'Kirkwood', label:'Kirkwood'}
  ];

  var VENUE_STATE = {ACCC:'NJ',BWH:'NJ',FMP:'NJ',Cure:'NJ',Mann:'PA',Subaru:'PA',Montage:'PA',Villanova:'PA',DE:'DE',SATB:'DE',Kirkwood:'DE'};
  var VENUE_FULL = {ACCC:'AC Convention Center',BWH:'Boardwalk Hall',Mann:'Mann Music Center',FMP:'Freedom Mortgage Pavilion',Cure:'Cure Insurance Arena',DE:'DE Chase Field House',Montage:'Montage Mountain',Subaru:'Subaru Park',Villanova:'Villanova',SATB:'Sports at the Beach',Kirkwood:'Kirkwood'};

  var VENUE_NAME_TO_CODE = {};
  VENUES.forEach(function(v) {
    VENUE_NAME_TO_CODE[v.code] = v.code;
    if (VENUE_FULL[v.code]) VENUE_NAME_TO_CODE[VENUE_FULL[v.code]] = v.code;
  });
  VENUE_NAME_TO_CODE['Boardwalk Hall'] = 'BWH';
  VENUE_NAME_TO_CODE['Cure Insurance Arena'] = 'Cure';
  VENUE_NAME_TO_CODE['DE Chase Field House'] = 'DE';
  VENUE_NAME_TO_CODE['Mann Music Center'] = 'Mann';
  VENUE_NAME_TO_CODE['Sports at the Beach'] = 'SATB';
  VENUE_NAME_TO_CODE['AC Convention Center'] = 'ACCC';

  function resolveVenueCode(name) { return VENUE_NAME_TO_CODE[name]||name; }

  /* Fiscal period -> inventory count_month (fixed Jul 29, 2026). The period
     NAME is the source, not the start date — see cos-labor history. */
  var MONTH_NUM = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  function periodCountMonth(period) {
    if (!period || !period.name) { console.error('[venue-economics] periodCountMonth got no period.'); return null; }
    var parts = String(period.name).trim().split(/\s+/);
    var mn = MONTH_NUM[(parts[0] || '').toLowerCase()];
    var yr = parseInt(parts[1], 10);
    if (!mn || isNaN(yr)) {
      console.error('[venue-economics] periodCountMonth could not parse period name "' + period.name + '" — falling back to start-date derivation, which may be wrong.');
      return period.start.slice(0, 8) + '01';
    }
    return yr + '-' + (mn < 10 ? '0' + mn : String(mn)) + '-01';
  }

  /* Fail-loud GET. Throws on any non-2xx so callers can't mistake an RLS
     denial for an empty table. */
  async function supa(path) {
    var r = await fetch(SUPA_URL+'/rest/v1/'+path, {headers: pcAuth.headers()});
    if (!r.ok) {
      var body=''; try { body = await r.text(); } catch(e) {}
      var err = new Error('supa GET '+path+' failed: HTTP '+r.status+(body?' — '+body:''));
      err.status = r.status; err.body = body;
      console.error('[venue-economics]', err);
      throw err;
    }
    return r.json();
  }

  function arr(x) { return Array.isArray(x) ? x : []; }

  /* ---------------- index builders ---------------- */

  /* Client-side approximation of the DB's pc_name_key(). Strips the legacy
     "- U" minor suffix, collapses whitespace, lowercases. */
  function laborNameKey(n) {
    return String(n == null ? '' : n)
      .replace(/\s*-\s*U\s*$/i, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildLaborIndexes(employees, evrRows) {
    var empIdByNameKey = {};
    (employees || []).forEach(function(e) {
      var k = laborNameKey((e.first_name || '') + ' ' + (e.last_name || ''));
      if (k) empIdByNameKey[k] = e.id;
    });
    var evrRateByKey = {};
    (evrRows || []).forEach(function(r) {
      if (r.pay_rate_override == null) return;
      var code = (r.venues || {}).code;
      var role = (r.roles || {}).name;
      if (!code || !role) return;
      evrRateByKey[r.employee_id + '||' + code + '||' + role] = Number(r.pay_rate_override);
    });
    return { empIdByNameKey: empIdByNameKey, evrRateByKey: evrRateByKey };
  }

  /* Uploaded payroll index: "venueCode|weekStart" -> {wages, ertax, hours}.
     Multiple lines can share a venue-week, so amounts accumulate. Only
     labor_type='variable' lines are fetched; fixed and overhead stay
     company-level. */
  function buildUploadedPayroll(lines) {
    var byKey = {};
    (lines || []).forEach(function(l) {
      var run = l.payroll_runs;
      if (!run || !run.pay_period_start) return;
      var vc = resolveVenueCode(l.venue_code);
      if (vc === '__company__' || vc === '__unresolved__') return;
      var key = vc + '|' + run.pay_period_start;
      if (!byKey[key]) byKey[key] = { wages: 0, ertax: 0, hours: 0 };
      byKey[key].wages += (parseFloat(l.regular_pay || 0) + parseFloat(l.ot_pay || 0));
      byKey[key].ertax += parseFloat(l.employer_tax_alloc || 0);
      byKey[key].hours += (parseFloat(l.regular_hours || 0) + parseFloat(l.ot_hours || 0));
    });
    return byKey;
  }

  /* AR-derived actuals — signed line amounts per venue by cos_class.
     'exclude' and unclassified skipped. */
  function buildArActuals(arLines) {
    var byVenue = {};
    (arLines || []).forEach(function(row) {
      var inv = row.ar_invoices, item = row.ar_items;
      if (!inv || !item) return;
      var cls = item.cos_class;
      if (cls !== 'cos_relatable' && cls !== 'other_sales' && cls !== 'labor_credit') return;
      var vc = resolveVenueCode(inv.venue_code);
      if (!byVenue[vc]) byVenue[vc] = { cos_relatable:0, other_sales:0, labor_credit:0, invoiceIds:{} };
      byVenue[vc][cls] += parseFloat(row.amount || 0);
      if (inv.id) byVenue[vc].invoiceIds[inv.id] = true;
    });
    Object.keys(byVenue).forEach(function(vc) {
      var b = byVenue[vc];
      b.invoiceCount = Object.keys(b.invoiceIds).length;
      b.cos_relatable = Math.round(b.cos_relatable * 100) / 100;
      b.other_sales   = Math.round(b.other_sales   * 100) / 100;
      b.labor_credit  = Math.round(b.labor_credit  * 100) / 100;
    });
    return byVenue;
  }

  /* ---------------- load one fiscal period ---------------- */

  async function load(p) {
    if (!p || !p.start || !p.end || !p.key) throw new Error('[venue-economics] load() needs a pcFiscal period');
    await pcRoles.ready();
    var pk = p.key;
    var results = await Promise.all([
      supa('sales?select=*&event_date=gte.'+p.start+'&event_date=lte.'+p.end),
      supa('purchases?deleted_at=is.null&select=*&invoice_date=gte.'+p.start+'&invoice_date=lte.'+p.end),
      supa('inventory_counts?select=*,inventory_items(name,unit_label,cost_per_unit)&count_month=eq.'+periodCountMonth(p)+'&item_id=neq.'+INVENTORY_SENTINEL),
      supa('deal_templates?select=*'),supa('stand_deals?select=*'),supa('pay_rates?select=*'),
      supa('client_billing_rates?select=*'),supa('eom_payroll?select=*&fiscal_period=eq.'+pk),
      supa('eom_manual_entries?select=*&fiscal_period=eq.'+pk),supa('eom_snapshots?select=*&fiscal_period=eq.'+pk),
      supa('events?select=*&event_date=gte.'+p.start+'&event_date=lte.'+p.end),
      supa('staffing_requests?select=*&submitted_at=gte.'+p.start+'T00:00:00&submitted_at=lte.'+p.end+'T23:59:59'),
      supa('ar_invoice_lines?select=amount,ar_items!inner(cos_class),ar_invoices!inner(id,venue_code,period_start,status)&ar_invoices.status=neq.voided&ar_invoices.period_start=gte.'+p.start+'&ar_invoices.period_start=lte.'+p.end+'&limit=50000').catch(function(e){console.warn('[venue-economics] AR actuals fetch failed (non-fatal):',e);return [];}),
      supa('employees?select=id,first_name,last_name&limit=2000'),
      supa('employee_venue_roles?select=employee_id,pay_rate_override,is_active,venues(code),roles(name)&is_active=eq.true&limit=5000'),
      supa('payroll_run_venue_lines?select=venue_code,labor_type,regular_pay,ot_pay,regular_hours,ot_hours,employer_tax_alloc,payroll_runs!inner(pay_period_start,deleted_at)&payroll_runs.deleted_at=is.null&labor_type=eq.variable&payroll_runs.pay_period_start=gte.'+p.start+'&payroll_runs.pay_period_start=lte.'+p.end+'&limit=5000').catch(function(e){console.warn('[venue-economics] uploaded payroll fetch failed (non-fatal):',e);return [];})
    ]);

    var ctx = {
      period: p,
      sales: arr(results[0]),
      purchases: arr(results[1]),
      inventoryRows: arr(results[2]),
      dealTemplates: arr(results[3]),
      standDeals: arr(results[4]),
      payRates: arr(results[5]),
      billingRates: arr(results[6]),
      payroll: arr(results[7]),
      manual: arr(results[8]),
      snapshot: null,
      events: arr(results[10]),
      staffing: arr(results[11]),
      arLines: arr(results[12]),
      payrollLines: arr(results[15]),
      placements: [],
      inventory: {},
      priorInventory: {}
    };
    var snapshots = arr(results[9]);
    ctx.snapshot = snapshots.length > 0 ? snapshots[0] : null;
    ctx.isLocked = !!ctx.snapshot;

    var li = buildLaborIndexes(arr(results[13]), arr(results[14]));
    ctx.empIdByNameKey = li.empIdByNameKey;
    ctx.evrRateByKey = li.evrRateByKey;
    ctx.uploadedPayroll = buildUploadedPayroll(ctx.payrollLines);
    ctx.arActuals = buildArActuals(ctx.arLines);

    /* Placements: position_assignments carries no event_date, so scope by
       event_id. Skipped for pre-cutoff periods (no rows exist). */
    if (p.start >= PLACEMENT_ERA_START) {
      var ids = ctx.events.map(function(e) { return '"' + e.id + '"'; });
      if (ids.length) {
        var inList = '(' + ids.join(',') + ')';
        ctx.placements = arr(await supa('position_assignments?event_id=in.' + encodeURIComponent(inList) +
          '&removed_at=is.null&select=id,event_id,venue,stand,role,staff_name&limit=20000'));
      }
    }

    ctx.inventoryRows.forEach(function(row){var vc=resolveVenueCode(row.venue);if(!ctx.inventory[vc])ctx.inventory[vc]=0;ctx.inventory[vc]+=parseFloat(row.value_on_hand||0);});
    var prior = pcFiscal.getPriorPeriod(p);
    if (prior) {
      var priorInv = await supa('inventory_counts?select=*&count_month=eq.'+periodCountMonth(prior)+'&item_id=neq.'+INVENTORY_SENTINEL);
      arr(priorInv).forEach(function(row){var vc=resolveVenueCode(row.venue);if(!ctx.priorInventory[vc])ctx.priorInventory[vc]=0;ctx.priorInventory[vc]+=parseFloat(row.value_on_hand||0);});
    }
    return ctx;
  }

  /* ---------------- revenue ---------------- */

  function calcRevenue(ctx, sale) {
    var venue=resolveVenueCode(sale.venue);var stand=sale.stand;var gross=parseFloat(sale.amount||0);
    if (!gross) return {cosRelatable:0,otherSales:0,reason:'zero_amount'};
    var sd=null;for (var i=0;i<ctx.standDeals.length;i++){if(ctx.standDeals[i].venue===venue&&ctx.standDeals[i].stand===stand){sd=ctx.standDeals[i];break;}}
    if (!sd) return {cosRelatable:0,otherSales:0,reason:'no_stand_deal',venue:venue,stand:stand};
    var dt=null;for (var j=0;j<ctx.dealTemplates.length;j++){if(ctx.dealTemplates[j].venue===venue&&ctx.dealTemplates[j].deal_type===sd.deal_type){dt=ctx.dealTemplates[j];break;}}
    var dealType=sd.deal_type;var cosRelatable=0;var otherSales=0;
    if (dealType==='rev_split') { var pct=(sd.has_override?sd.override_rev_split_pct:null)||(dt?dt.rev_split_pct:70); cosRelatable=gross*(pct/100); }
    else if (dealType==='rev_bev') { var foodPct=(sd.has_override?sd.override_bev_food_pct:null)||(dt?dt.bev_food_pct:91); var bevPct=(sd.has_override?sd.override_bev_bev_pct:null)||(dt?dt.bev_bev_pct:9); var foodCut=(sd.has_override?sd.override_bev_food_cut:null)||(dt?dt.bev_food_cut:70); var bevComm=(sd.has_override?sd.override_bev_bev_comm:null)||(dt?dt.bev_bev_comm:10); var foodSales=gross*(foodPct/100); var bevSales=gross*(bevPct/100); cosRelatable=foodSales*(foodCut/100); otherSales=bevSales*(bevComm/100); }
    else if (dealType==='labor') { var comm=(sd.has_override?sd.override_labor_comm:null)||(dt?dt.labor_comm:15); otherSales=gross*(comm/100); }
    else if (dealType==='reimb') { var rComm=(sd.has_override?sd.override_reimb_comm:null)||(dt?dt.reimb_comm:5); otherSales=gross*(rComm/100); }
    return {cosRelatable:cosRelatable,otherSales:otherSales,reason:'matched'};
  }

  /* ---------------- labor estimate (v2, Aug 2026) ---------------- */

  /* Event hours — carried over UNCHANGED from the original estimator. Known
     gaps: no post-show breakdown, null end defaults to 23:00, past-midnight
     shows fall back to 6 hours. The hours model is a separate pass. */
  function eventHours(evt) {
    var reportTime = evt.report_time || evt.gates_open;
    var endTime = evt.estimated_end_time;
    var hours = 6;
    if (reportTime) {
      var sp = reportTime.split(':');
      var startH = parseInt(sp[0]);
      var startM = parseInt(sp[1] || 0);
      if (!evt.report_time && evt.gates_open) { startH = startH - 1; if (startH < 0) startH = 0; }
      var endH = 23, endM = 0;
      if (endTime) {
        var ep = endTime.split(':');
        endH = parseInt(ep[0]);
        endM = parseInt(ep[1] || 0);
      }
      hours = (endH + endM / 60) - (startH + startM / 60);
      if (hours <= 0) hours = 6;
    }
    return hours;
  }

  function newUnpricedAcc() { return {}; }

  function noteUnpriced(acc, venueCode, label) {
    if (!acc) return;
    if (!acc[venueCode]) acc[venueCode] = { count: 0, pairs: {} };
    acc[venueCode].count++;
    acc[venueCode].pairs[label] = (acc[venueCode].pairs[label] || 0) + 1;
  }

  /* Rate for ONE placement:
       1. that person's own pay_rate_override for (venue, role)
       2. the venue's rate for that role (venue_roles.pay_rate)
       3. unpriced -> 0, counted for the on-page callout
     A 0 from a real row (Hawker commission, salaried Venue Manager) is a
     legitimate answer and is NOT flagged. */
  function placementRate(ctx, acc, staffName, venueCode, rawRole) {
    var role = pcRoles.legacyToCanonical(rawRole);
    if (!role || role === '__MULTI__') {
      noteUnpriced(acc, venueCode, venueCode + ' / ' + (rawRole || '(blank)') + ' \u2014 unmapped role');
      return 0;
    }
    var empId = ctx.empIdByNameKey[laborNameKey(staffName)];
    if (empId) {
      var ov = ctx.evrRateByKey[empId + '||' + venueCode + '||' + role];
      if (ov !== undefined && ov !== null && !isNaN(ov)) return ov;
    }
    var def = null;
    try { def = pcRoles.getPayRate(venueCode, role); } catch (e) { def = null; }
    if (def === null || def === undefined) {
      noteUnpriced(acc, venueCode, venueCode + ' / ' + role + (empId ? '' : ' \u2014 name not matched'));
      return 0;
    }
    return def;
  }

  function calcEstimatedLabor(ctx, acc, venueCode, weekStart, weekEnd) {
    if (ctx.period.start < PLACEMENT_ERA_START) return legacyEstimatedLabor(ctx, venueCode, weekStart, weekEnd);
    var total = 0;
    var eventsInWeek = ctx.events.filter(function(e) {
      return e.event_date >= weekStart && e.event_date <= weekEnd;
    });
    eventsInWeek.forEach(function(evt) {
      var hours = eventHours(evt);
      ctx.placements.forEach(function(pa) {
        if (pa.event_id !== evt.id) return;
        if (resolveVenueCode(pa.venue) !== venueCode) return;
        total += hours * placementRate(ctx, acc, pa.staff_name, venueCode, pa.role);
      });
    });
    return total;
  }

  /* FROZEN — fiscal periods starting before 2026-04-30 ONLY. Requested
     headcount x flat state/role rate. DO NOT MAINTAIN. DO NOT EXTEND. */
  function legacyEstimatedLabor(ctx, venueCode, weekStart, weekEnd) {
    var total = 0;
    var eventsInWeek = ctx.events.filter(function(e) {
      return e.event_date >= weekStart && e.event_date <= weekEnd;
    });
    eventsInWeek.forEach(function(evt) {
      var requests = ctx.staffing.filter(function(sr) {
        return sr.event_id === evt.id && resolveVenueCode(sr.venue) === venueCode;
      });
      requests.forEach(function(sr) {
        var headcount = sr.headcount || 0;
        if (headcount <= 0) return;
        var hours = eventHours(evt);
        var st = VENUE_STATE[venueCode] || 'NJ';
        var rate = 0;
        for (var k = 0; k < ctx.payRates.length; k++) {
          if (ctx.payRates[k].state === st && ctx.payRates[k].role === sr.role) {
            rate = parseFloat(ctx.payRates[k].base_rate || 0);
            break;
          }
        }
        total += headcount * hours * rate;
      });
    });
    return total;
  }

  function calcEstimatedLaborCredit(ctx, venueCode) {
    var total=0;ctx.events.forEach(function(evt){var requests=ctx.staffing.filter(function(sr){return sr.event_id===evt.id&&resolveVenueCode(sr.venue)===venueCode&&sr.stand==='Client Staffing Needs';});
      requests.forEach(function(sr){var headcount=sr.headcount||0;if(headcount<=0)return;var reportTime=evt.report_time||evt.gates_open;var endTime=evt.estimated_end_time;var hours=6;
        if(reportTime){var startParts=reportTime.split(':');var startH=parseInt(startParts[0]);var startM=parseInt(startParts[1]||0);if(!evt.report_time&&evt.gates_open){startH=startH-1;if(startH<0)startH=0;}var endH=23;var endM=0;if(endTime){var endParts=endTime.split(':');endH=parseInt(endParts[0]);endM=parseInt(endParts[1]||0);}hours=(endH+endM/60)-(startH+startM/60);if(hours<=0)hours=6;}
        var billingRate=0;for(var k=0;k<ctx.billingRates.length;k++){if(ctx.billingRates[k].venue===venueCode&&ctx.billingRates[k].role===sr.role){billingRate=parseFloat(ctx.billingRates[k].billing_rate||0);break;}}
        total+=headcount*hours*billingRate;});});
    return total;
  }

  /* ---------------- per-venue build ---------------- */

  function buildVenue(ctx, venueCode, acc) {
    var p=ctx.period;var pk=p.key;var weeks=pcFiscal.getWeekRanges(p);
    var cosRelatable=0;var otherSalesTotal=0;var venueSales=ctx.sales.filter(function(s){return resolveVenueCode(s.venue)===venueCode;});
    var unmatchedGross=0;var unmatchedStands={};var unmatchedSaleCount=0;var grossSales=0;
    venueSales.forEach(function(s){var rev=calcRevenue(ctx,s);cosRelatable+=rev.cosRelatable;otherSalesTotal+=rev.otherSales;var amt=parseFloat(s.amount||0);grossSales+=amt;
      if(rev.reason==='no_stand_deal'){unmatchedSaleCount++;unmatchedGross+=amt;var key=(rev.venue||'?')+' / '+(rev.stand||'(blank)');if(!unmatchedStands[key])unmatchedStands[key]={count:0,gross:0};unmatchedStands[key].count++;unmatchedStands[key].gross+=amt;}
    });
    var salesDiag={totalSaleRows:venueSales.length,grossSales:grossSales,unmatchedSaleCount:unmatchedSaleCount,unmatchedGross:unmatchedGross,unmatchedStands:unmatchedStands};
    var totalSales=cosRelatable+otherSalesTotal;var begInv=ctx.priorInventory[venueCode]||0;
    var invoices=ctx.purchases.filter(function(r){return r.type==='invoice'&&resolveVenueCode(r.venue)===venueCode;});
    var weeklyPurchases=weeks.map(function(w){var weekInvoices=invoices.filter(function(inv){return inv.invoice_date>=w.start&&inv.invoice_date<=w.end;});var total=weekInvoices.reduce(function(s,inv){return s+parseFloat(inv.amount||0);},0);return{label:w.label,start:w.start,end:w.end,total:total,invoices:weekInvoices};});
    var totalPurchases=weeklyPurchases.reduce(function(s,w){return s+w.total;},0);var allInvoices=invoices.slice();
    var transferEntry=ctx.manual.filter(function(m){return m.venue===venueCode&&m.fiscal_period===pk&&m.entry_type==='transfer';});
    var transfers=transferEntry.length>0?parseFloat(transferEntry[0].amount||0):0;var endInv=ctx.inventory[venueCode]||0;var consumption=begInv+totalPurchases+transfers-endInv;
    var estPayrollWeeks=weeks.map(function(w){return calcEstimatedLabor(ctx,acc,venueCode,w.start,w.end);});var estPayrollTotal=estPayrollWeeks.reduce(function(s,v){return s+v;},0);
    /* Uploaded wins over manual. The manual box stays only as a fallback
       for un-uploaded weeks. Hours exist only for uploaded weeks. */
    var actPayrollSource=[];
    var erTaxWeeks=[];
    var actHoursWeeks=[];
    var actPayrollWeeks=weeks.map(function(w){
      var up=ctx.uploadedPayroll[venueCode+'|'+w.start];
      if(up){actPayrollSource.push('uploaded');erTaxWeeks.push(Math.round(up.ertax*100)/100);actHoursWeeks.push(Math.round(up.hours*100)/100);return Math.round(up.wages*100)/100;}
      erTaxWeeks.push(0);actHoursWeeks.push(0);
      var entry=ctx.payroll.filter(function(pr){return pr.venue===venueCode&&pr.week_start===w.start;});
      if(entry.length>0){actPayrollSource.push('manual');return parseFloat(entry[0].amount||0);}
      actPayrollSource.push(null);return null;
    });
    var actPayrollTotal=actPayrollWeeks.reduce(function(s,v){return s+(v||0);},0);var hasAnyPayroll=actPayrollWeeks.some(function(v){return v!==null;});
    var erTaxTotal=erTaxWeeks.reduce(function(s,v){return s+v;},0);
    var actHoursTotal=actHoursWeeks.reduce(function(s,v){return s+v;},0);
    var hoursWeeksUploaded=actPayrollSource.filter(function(s){return s==='uploaded';}).length;
    var estLaborCredit=calcEstimatedLaborCredit(ctx,venueCode);var lcEntry=ctx.manual.filter(function(m){return m.venue===venueCode&&m.fiscal_period===pk&&m.entry_type==='labor_credit';});
    var ar=ctx.arActuals[venueCode]||null;var hasAr=!!ar;var arCos=ar?ar.cos_relatable:0;var arOther=ar?ar.other_sales:0;var arLabor=ar?ar.labor_credit:0;var arInvoiceCount=ar?ar.invoiceCount:0;
    var laborCreditOverride=lcEntry.length>0?parseFloat(lcEntry[0].amount):null;
    var laborCredit,laborCreditSource;if(laborCreditOverride!==null){laborCredit=laborCreditOverride;laborCreditSource='manual';}else if(hasAr){laborCredit=arLabor;laborCreditSource='ar';}else{laborCredit=estLaborCredit;laborCreditSource='estimate';}
    var lcNote=lcEntry.length>0?lcEntry[0].note:null;var lcEnteredBy=lcEntry.length>0?lcEntry[0].entered_by:null;
    var actCosEntry=ctx.manual.filter(function(m){return m.venue===venueCode&&m.fiscal_period===pk&&m.entry_type==='actual_cos_revenue';});
    var actOtherEntry=ctx.manual.filter(function(m){return m.venue===venueCode&&m.fiscal_period===pk&&m.entry_type==='actual_other_revenue';});
    var actualCosRevenue=actCosEntry.length>0?parseFloat(actCosEntry[0].amount):null;var actualOtherRevenue=actOtherEntry.length>0?parseFloat(actOtherEntry[0].amount):null;
    var actRevEnteredBy=actCosEntry.length>0?actCosEntry[0].entered_by:null;
    var activeCosRelatable,cosSource;if(actualCosRevenue!==null){activeCosRelatable=actualCosRevenue;cosSource='manual';}else if(hasAr){activeCosRelatable=arCos;cosSource='ar';}else{activeCosRelatable=cosRelatable;cosSource='estimate';}
    var activeOtherSales,otherSource;if(actualOtherRevenue!==null){activeOtherSales=actualOtherRevenue;otherSource='manual';}else if(hasAr){activeOtherSales=arOther;otherSource='ar';}else{activeOtherSales=otherSalesTotal;otherSource='estimate';}
    var activeTotalSales=activeCosRelatable+activeOtherSales;
    var cosPercent=activeCosRelatable>0?consumption/activeCosRelatable:0;var laborPercent=activeTotalSales>0?actPayrollTotal/activeTotalSales:0;
    var correctedLabor=actPayrollTotal-laborCredit;var correctedLaborPct=activeCosRelatable>0?correctedLabor/activeCosRelatable:0;var payrollVariance=actPayrollTotal-estPayrollTotal;
    return {venueCode:venueCode,cosRelatable:cosRelatable,otherSales:otherSalesTotal,totalSales:totalSales,begInv:begInv,weeklyPurchases:weeklyPurchases,totalPurchases:totalPurchases,allInvoices:allInvoices,transfers:transfers,endInv:endInv,consumption:consumption,cosPercent:cosPercent,weeks:weeks,estPayrollWeeks:estPayrollWeeks,estPayrollTotal:estPayrollTotal,actPayrollWeeks:actPayrollWeeks,actPayrollTotal:actPayrollTotal,hasAnyPayroll:hasAnyPayroll,actPayrollSource:actPayrollSource,erTaxWeeks:erTaxWeeks,erTaxTotal:erTaxTotal,actHoursWeeks:actHoursWeeks,actHoursTotal:actHoursTotal,hoursWeeksUploaded:hoursWeeksUploaded,laborPercent:laborPercent,estLaborCredit:estLaborCredit,laborCreditOverride:laborCreditOverride,laborCredit:laborCredit,lcNote:lcNote,lcEnteredBy:lcEnteredBy,correctedLabor:correctedLabor,correctedLaborPct:correctedLaborPct,payrollVariance:payrollVariance,actualCosRevenue:actualCosRevenue,actualOtherRevenue:actualOtherRevenue,actRevEnteredBy:actRevEnteredBy,activeCosRelatable:activeCosRelatable,activeOtherSales:activeOtherSales,activeTotalSales:activeTotalSales,hasAr:hasAr,arCos:arCos,arOther:arOther,arLabor:arLabor,arInvoiceCount:arInvoiceCount,cosSource:cosSource,otherSource:otherSource,laborCreditSource:laborCreditSource,salesDiag:salesDiag};
  }

  /* ---------------- merge (combined venues) ---------------- */

  function mergeVenues(ctx, codes, acc) {
    var all=codes.map(function(c){return buildVenue(ctx,c,acc);});if(all.length===1)return all[0];
    var merged={venueCode:'COMBINED',cosRelatable:0,otherSales:0,totalSales:0,begInv:0,totalPurchases:0,transfers:0,endInv:0,consumption:0,weeklyPurchases:[],allInvoices:[],weeks:all[0].weeks,estPayrollWeeks:[],estPayrollTotal:0,actPayrollWeeks:[],actPayrollTotal:0,hasAnyPayroll:false,actPayrollSource:[],erTaxWeeks:[],erTaxTotal:0,actHoursWeeks:[],actHoursTotal:0,hoursWeeksUploaded:0,estLaborCredit:0,laborCreditOverride:null,laborCredit:0,correctedLabor:0,lcNote:null,lcEnteredBy:null,hasAr:false,arCos:0,arOther:0,arLabor:0,arInvoiceCount:0,activeCosRelatable:0,activeOtherSales:0,cosSource:'estimate',otherSource:'estimate',laborCreditSource:'estimate',salesDiag:{totalSaleRows:0,grossSales:0,unmatchedSaleCount:0,unmatchedGross:0,unmatchedStands:{}}};
    var numWeeks=merged.weeks.length;for(var w=0;w<numWeeks;w++){merged.weeklyPurchases.push({label:merged.weeks[w].label,start:merged.weeks[w].start,end:merged.weeks[w].end,total:0,invoices:[]});merged.estPayrollWeeks.push(0);merged.actPayrollWeeks.push(null);merged.actPayrollSource.push(null);merged.erTaxWeeks.push(0);merged.actHoursWeeks.push(0);}
    all.forEach(function(vd){merged.cosRelatable+=vd.cosRelatable;merged.otherSales+=vd.otherSales;merged.totalSales+=vd.totalSales;merged.begInv+=vd.begInv;merged.totalPurchases+=vd.totalPurchases;merged.transfers+=vd.transfers;merged.endInv+=vd.endInv;merged.consumption+=vd.consumption;merged.allInvoices=merged.allInvoices.concat(vd.allInvoices);merged.estPayrollTotal+=vd.estPayrollTotal;merged.actPayrollTotal+=vd.actPayrollTotal;merged.erTaxTotal+=vd.erTaxTotal;merged.actHoursTotal+=vd.actHoursTotal;merged.hoursWeeksUploaded+=vd.hoursWeeksUploaded;for(var sw=0;sw<numWeeks;sw++){merged.erTaxWeeks[sw]+=(vd.erTaxWeeks[sw]||0);merged.actHoursWeeks[sw]+=(vd.actHoursWeeks[sw]||0);if(vd.actPayrollSource[sw]==='uploaded')merged.actPayrollSource[sw]='uploaded';else if(vd.actPayrollSource[sw]==='manual'&&!merged.actPayrollSource[sw])merged.actPayrollSource[sw]='manual';}merged.estLaborCredit+=vd.estLaborCredit;if(vd.hasAnyPayroll)merged.hasAnyPayroll=true;if(vd.hasAr)merged.hasAr=true;merged.arCos+=vd.arCos;merged.arOther+=vd.arOther;merged.arLabor+=vd.arLabor;merged.arInvoiceCount+=vd.arInvoiceCount;merged.activeCosRelatable+=vd.activeCosRelatable;merged.activeOtherSales+=vd.activeOtherSales;merged.laborCredit+=vd.laborCredit;for(var w2=0;w2<numWeeks;w2++){merged.weeklyPurchases[w2].total+=vd.weeklyPurchases[w2].total;merged.weeklyPurchases[w2].invoices=merged.weeklyPurchases[w2].invoices.concat(vd.weeklyPurchases[w2].invoices);merged.estPayrollWeeks[w2]+=vd.estPayrollWeeks[w2];if(vd.actPayrollWeeks[w2]!==null){if(merged.actPayrollWeeks[w2]===null)merged.actPayrollWeeks[w2]=0;merged.actPayrollWeeks[w2]+=vd.actPayrollWeeks[w2];}}
      if(vd.salesDiag){merged.salesDiag.totalSaleRows+=vd.salesDiag.totalSaleRows;merged.salesDiag.grossSales+=vd.salesDiag.grossSales;merged.salesDiag.unmatchedSaleCount+=vd.salesDiag.unmatchedSaleCount;merged.salesDiag.unmatchedGross+=vd.salesDiag.unmatchedGross;Object.keys(vd.salesDiag.unmatchedStands).forEach(function(k){if(!merged.salesDiag.unmatchedStands[k])merged.salesDiag.unmatchedStands[k]={count:0,gross:0};merged.salesDiag.unmatchedStands[k].count+=vd.salesDiag.unmatchedStands[k].count;merged.salesDiag.unmatchedStands[k].gross+=vd.salesDiag.unmatchedStands[k].gross;});}
    });
    merged.laborCreditOverride=null;merged.laborCreditSource=merged.hasAr?'ar':'estimate';
    var mergedActCos=null;var mergedActOther=null;var anyActCos=false;var anyActOther=false;
    all.forEach(function(vd){if(vd.actualCosRevenue!==null){anyActCos=true;if(mergedActCos===null)mergedActCos=0;mergedActCos+=vd.actualCosRevenue;}if(vd.actualOtherRevenue!==null){anyActOther=true;if(mergedActOther===null)mergedActOther=0;mergedActOther+=vd.actualOtherRevenue;}});
    merged.actualCosRevenue=anyActCos?mergedActCos:null;merged.actualOtherRevenue=anyActOther?mergedActOther:null;merged.actRevEnteredBy=null;
    merged.cosSource=merged.hasAr?'ar':'estimate';merged.otherSource=merged.hasAr?'ar':'estimate';
    merged.activeTotalSales=merged.activeCosRelatable+merged.activeOtherSales;
    merged.cosPercent=merged.activeCosRelatable>0?merged.consumption/merged.activeCosRelatable:0;merged.laborPercent=merged.activeTotalSales>0?merged.actPayrollTotal/merged.activeTotalSales:0;merged.correctedLabor=merged.actPayrollTotal-merged.laborCredit;merged.correctedLaborPct=merged.activeCosRelatable>0?merged.correctedLabor/merged.activeCosRelatable:0;merged.payrollVariance=merged.actPayrollTotal-merged.estPayrollTotal;
    return merged;
  }

  global.pcVenueEconomics = {
    load: load,
    buildVenue: buildVenue,
    mergeVenues: mergeVenues,
    calcRevenue: calcRevenue,
    resolveVenueCode: resolveVenueCode,
    periodCountMonth: periodCountMonth,
    newUnpricedAcc: newUnpricedAcc,
    VENUES: VENUES,
    VENUE_FULL: VENUE_FULL,
    VENUE_STATE: VENUE_STATE,
    PLACEMENT_ERA_START: PLACEMENT_ERA_START
  };
})(window);
