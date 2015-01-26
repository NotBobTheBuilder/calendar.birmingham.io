var ical = require("ical"),
    async = require("async"),
    request = require("request"),
    config = require("./config"),
    googleapis = require('googleapis'),
    crypto = require("crypto"),
    moment = require("moment"),
    fs = require("fs"),
    time = require("time"),
    Handlebars = require("handlebars");

/* Override the ical library's RRULE parser because Google Calendar doesn't
   want parsed rrules, it wants an unparsed string, so we stash the unparsed
   string on the object so we can get at it later. */
var existing_rrule_handler = ical.objectHandlers.RRULE;
ical.objectHandlers.RRULE = function(val, params, curr, stack, line) {
    if (curr.unparsed_rrules) {
        curr.unparsed_rrules.push(line);
    } else {
        curr.unparsed_rrules = [line];
    }
    return existing_rrule_handler(val, params, curr, stack, line);
};

/* Google */
var SERVICE_ACCOUNT_EMAIL = '721976846481-1s5altpg8afuc4opnlr13nua86hg0ul9@developer.gserviceaccount.com';
var SERVICE_ACCOUNT_KEY_FILE = './key.pem';
var GOOGLE_CALENDAR_ID = 'movdt8poi0t3gfedfd80u1kcak@group.calendar.google.com';
var jwt = new googleapis.auth.JWT(
        SERVICE_ACCOUNT_EMAIL,
        SERVICE_ACCOUNT_KEY_FILE,
        null,
        ['https://www.googleapis.com/auth/calendar']);

/* Meetup */
var MEETUP_KEY = config.MEETUPKEY;
var MEETUP_URL = "https://api.meetup.com/find/groups?" +
                    "&sign=true" +
                    "&photo-host=public" +
                    "&category=34" + /* Technology */
                    "&lat=52.483056&lon=-1.893611" + /* Birmingham */
                    "&radius=5" + /* radius (in miles) */
                    "&page=4000" + /* results per page */
                    "&key=";

var tz = new time.Date();
var TIMEZONE = tz.getTimezone();

/* FetchIcalUrls functions have to return a list of {source, url} objects.
   A source must be a short word which identifies the source somehow
   (for example, "meetup" for meetup iCal files) -- it is used to make sure
   that IDs from different sources don't collide. For boring technical reasons 
   (https://developers.google.com/google-apps/calendar/v3/reference/events#id)
   the source must also contain only characters 0-9 and a-v (not a-z, and not
   capital letters). 

   NOTE: a source is expected and required to provide UIDs for each event, and
   those UIDs must be both unique in that source and unchanging over time; if
   we request data from that source again later and one of the events that comes
   back was in this fetch too, then it must have the same UID. Otherwise it will
   be duplicated in the b.io calendar. Any source which does not enforce this is
   stupid, but if it does, it is your responsibility to provide a URL which *does*
   enforce it.
*/

function fetchIcalUrlsFromLocalFile(cb) {
    var fn = "explicitIcalUrls.json";
    fs.readFile(fn, function(err, data) {
        if (err) {
            console.log("Failed to read local file of icals", fn);
            cb(null, []);
            return;
        }
        var j;
        try {
            j = JSON.parse(data);
        } catch(e) {
            console.log("Failed to read local file of icals", fn, e);
            cb(null, []);
            return;
        }
        var urls = [];
        j.forEach(function(item) {
            urls.push({source: item.source, url: item.url});
        });
        cb(null, urls);
    });
}

function fetchIcalUrlsFromMeetup(cb) {
    if(MEETUP_URL && MEETUP_KEY) {
        var req = request(MEETUP_URL + MEETUP_KEY, function(err, response, body) {
            if (err) {
                console.log("Meetup: Error connecting:", err);
                cb(null, []);
                return;
            }
            else if (response.statusCode != 200) {
                console.log("Meetup: HTTP error code:", response.statusCode);
                cb(null, []);
                return;
            }
            else {
                try {
                    results = JSON.parse(body);
                    if (results.length === 0) {
                        console.log("Meetup: Warning: no results received:");
                    }
                    urls = [];
                    for (var result in results) {
                        urls.push({source: "meetup", url: results[result].link + "events/ical/"});
                    }
                    cb(null, urls);
                } catch(e) {
                    console.log("Meetup: Error parsing JSON:", e);
                    cb(null, []);
                    return;
                }
            }
        });
    }
    else {
        console.log("Meetup: No MEETUP_URL and/or MEETUP_KEY found in config");
        cb(null, []);
        return;
    }
}

var renderWebsite = function(events, done) {
    var now = moment();
    var ne = [];
    events.forEach(function(ev) {
        ev.start_parsed = moment(ev.start.dateTime);
        ev.end_parsed = moment(ev.end.dateTime);
        ev.date_as_str = ev.start_parsed.format("ha") + "&ndash;" + ev.end_parsed.format("ha") + " " +
            ev.start_parsed.format("ddd Do MMM");
        ev.url_escaped_location = encodeURIComponent(ev.location);
        if (ev.start_parsed.diff(now, "hours") < -1) {
            // discard
        } else {
            ne.push(ev);
        }
    });
    events = ne;
    events.sort(function(a,b) {
        if (b.start.dateTime < a.start.dateTime) { return 1; }
        if (b.start.dateTime > a.start.dateTime) { return -1; }
        return 0;
    });

    var next_midnight = moment().endOf("day"), next_week = moment().add(7, 'days');
    if (next_midnight.diff(now, "hours") > -3) {
        // the next midnight is less than three hours away (it's after 9pm), so get the one after that
        next_midnight = next_midnight.add(1, "days");
    }

    fs.readFile("./templates/index.handlebars", function(err, tplsrc) {
        if (err) { return done(err); }
        Handlebars.registerHelper('breaklines_linkify', function(text) {
            text = Handlebars.Utils.escapeExpression(text);
            text = text.replace(/(\r\n|\n|\r)/gm, '<br>');
            text = text.replace(/(https?:\/\/\S+)/gi, function (s) {
                return '<a href="' + s + '">' + s + '</a>';
            });
            text = text.replace(/(^|)@(\w+)/gi, function (s) {
                return '<a href="http://twitter.com/' + s + '">' + s + '</a>';
            });
            text = text.replace(/(^|)#(\w+)/gi, function (s) {
                return '<a href="http://search.twitter.com/search?q=' + s.replace(/#/,'%23') + '">' + s + '</a>';
            });
            return new Handlebars.SafeString(text);
        });
        var tpl = Handlebars.compile(tplsrc.toString());
        var idxhtml = tpl({
            upcoming: events.filter(function(ev) { return ev.start_parsed.diff(next_midnight) < 0; }),
            thisweek: events.filter(function(ev) { 
                return ev.start_parsed.diff(next_midnight) >= 0 && ev.start_parsed.diff(next_week) < 0; 
            }),
            remaining: events.filter(function(ev) { return ev.start_parsed.diff(next_week) >= 0; }).length
        });
        fs.writeFile("../website/out.html", idxhtml, function(err) {
            if (err) { return done(err); }
            done();
        });
    });

};

var getEventsFromGCal = function(CACHEFILE, done) {
    jwt.authorize(function(err, tokens) {
        if (err) { return done(err); }
        var gcal = googleapis.calendar('v3');
        /* Get list of events */
        gcal.events.list({auth: jwt, calendarId: GOOGLE_CALENDAR_ID, showDeleted: true}, function(err, resp) {
            if (err) { return done(err); }
            var events = resp.items;
            // save to cache
            fs.writeFile(CACHEFILE, JSON.stringify(events), function(err) {
                if (err) { console.warn("Couldn't write cache file", err); }
                renderWebsite(events, done);
            });
        });
    });
};

exports.createWebsite = function(done) {
    // if there's a cache file locally and it's less than 50 minutes old, use it
    var CACHEFILE = "./events.json.cache";
    fs.stat(CACHEFILE, function(err, stats) {
        if (!err && ((new Date()).getTime() - stats.mtime.getTime()) < 3000000) {
            fs.readFile(CACHEFILE, function(err, data) {
                if (err) {
                    console.warn("Tried to read cachefile", CACHEFILE, "and couldn't because", err);
                    getEventsFromGCal(CACHEFILE, done);
                    return;
                }
                var events;
                try {
                    events = JSON.parse(data);
                } catch(e) {
                    console.warn("Cachefile was not valid JSON:", e);
                    getEventsFromGCal(CACHEFILE, done);
                    return;
                }
                console.log("Read events from cache");
                renderWebsite(events, done);
            });
        } else {
            getEventsFromGCal(CACHEFILE, done);
        }
    });
};

// first, get a list of ics urls from various places
exports.mainJob = function mainJob() {
    async.parallel([
        fetchIcalUrlsFromLocalFile,
        fetchIcalUrlsFromMeetup
    ], function(err, results) {
        if (err) {
            console.log("We failed to get a list of ics URLs", err);
            return;
        }
        // flatten results list and fetch them all
        var icsurls = [];
        icsurls = icsurls.concat.apply(icsurls, results);
        async.map(icsurls, function(icsurlobj, cb) {
            request(icsurlobj.url, function(err, response, body) {
                if (err) { 
                    console.log("Failed to fetch URL", icsurlobj.url, err);
                    body = null;
                }
                // sanitise source name. Shouldn't need this, because people are
                // supposed to read the above comment, but nobody ever does. So,
                // a source name must match [a-v0-9] (no punctuation)
                var source = icsurlobj.source.toLowerCase().replace(/[^a-v0-9]/g, '').substr(0,40);
                cb(null, {source: source, body: body});
            });
        }, function(err, results) {
            if (err) { 
                console.log("We failed to fetch any ics URLs", err);
                return;
            }
            // parse them all into ICS structures
            async.concat(results, function(icsbodyobj, cb) {
                var events = [];
                if (icsbodyobj.body) {
                    var parsedEvents = ical.parseICS(icsbodyobj.body);
                    for (var k in parsedEvents) {
                        if (parsedEvents.hasOwnProperty(k)) {
                            var ev = parsedEvents[k];
                            if (ev.type != "VEVENT") {
                                /* Some ical files, including those from meetup, contain VTIMEZONE entries.
                                   Skip them, since they are not actually events, and epic fail lies within. */
                                continue;
                            }
                            ev.icalLibraryId = k;
                            /* the birminghamIOCalendarID is the ID we eventually
                               use to store this event in Google Calendar. As for
                               sources, above, it must match /^[a-v0-9]+$/, and must
                               be unique in the calendar. So, we assume that event.uid
                               exists and is unique in the thing that we fetched, but
                               can take any form it likes, and we construct an actually
                               unique ID as "bio" + source + sha1(event.uid).hexdigest
                               (because the hex digest of anything is /^[0-9a-f]+$/).
                               That way, this ID is all of calendar-unique, probably
                               globally-unique (because of the "bio"), and suitable
                               for use as a gcal ID. */
                            var shasum = crypto.createHash('sha1');
                            try {
                                shasum.update(ev.uid);
                                ev.birminghamIOCalendarID = "bio" + icsbodyobj.source + shasum.digest('hex');
                                events.push(ev);
                            } catch(e) {
                                console.log("Missing ev.uid", e, ev);
                            }
                        }
                    }
                }
                cb(null, events);
            }, function(err, results) {
                if (err) { 
                    console.log("We failed to create a list of events", err);
                    return;
                }

                // auth to the google calendar
                jwt.authorize(function(err, tokens) {
                    if (err) { console.log("Problem authorizing to Google", err); return; }
                    var gcal = googleapis.calendar('v3');

                    /* Get list of events */
                    gcal.events.list({auth: jwt, calendarId: GOOGLE_CALENDAR_ID, showDeleted: true}, function(err, resp) {
                        if (err) { console.log("Problem getting existing events", err); return; }
                        // Make a list of existing events keyed by uid, which is the unique key we created
                        var existing = {};
                        resp.items.forEach(function(ev) { existing[ev.id] = ev; });
                        
                        // Make a list of events which are in the google calendar and are *not* upstream, and flag them
                        var deletedUpstream = [];
                        var presentUpstream = {};
                        results.forEach(function(upstr) {
                            presentUpstream[upstr.birminghamIOCalendarID] = "yes";
                        });
                        for (var bioid in existing) {
                            if (!presentUpstream[bioid]) {
                                deletedUpstream.push(existing[bioid]);
                            }
                        }

                        /* Now, go through each of our fetched events and either update them 
                           if they exist, or create them if not. Note that we do not pass an
                           err in the update/insert to the callback, because that will terminate
                           the async.map; instead, we always say that there was no error, and
                           then if there was we pass it inside the results, so we can check later. */
                        async.mapSeries(results, function(ev, callback) {
                            var event_resource = {
                                start: { dateTime: moment(ev.start).format() },
                                end: { dateTime: moment(ev.end).format() },
                                description: ev.description || "",
                                location: ev.location || "",
                                summary: ev.summary,
                                status: "confirmed"
                            };
                            if (ev.unparsed_rrules) {
                                event_resource.recurrence = ev.unparsed_rrules;
                                /* Recurring events require an explicit start and end timezone.
                                   Timezones are hard. Fortunately, we are in England and so don't care.
                                   Send her victorious. */
                                event_resource.start.timeZone = TIMEZONE;
                                event_resource.end.timeZone = TIMEZONE;
                            }
                            if (existing[ev.birminghamIOCalendarID]) {
                                //console.log("Update event", ev.birminghamIOCalendarID);
                                gcal.events.patch({
                                    auth: jwt, 
                                    calendarId: GOOGLE_CALENDAR_ID,
                                    eventId: ev.birminghamIOCalendarID,
                                    resource: event_resource
                                }, function(err, resp) {
                                    if (err) {
                                        callback(null, {success: false, err: err, type: "update", event: ev});
                                        return;
                                    }
                                    callback(null, {success: true, type: "update", event: ev});
                                });
                            } else {
                                var event_resource_clone = JSON.parse(JSON.stringify(event_resource));
                                event_resource_clone.id = ev.birminghamIOCalendarID;
                                gcal.events.insert({
                                    auth: jwt, 
                                    calendarId: GOOGLE_CALENDAR_ID,
                                    resource: event_resource_clone
                                }, function(err, resp) {
                                    if (err) {
                                        callback(null, {success: false, err: err, type: "insert", event: ev});
                                        return;
                                    }
                                    callback(null, {success: true, type: "insert", event: ev});
                                });
                            }
                        }, function(err, results) {
                            if (err) { console.log("Update/insert got an error (this shouldn't happen!)", err); return; }
                            var successes = [], failures = [], inserts = 0, updates = 0;
                            results.forEach(function(r) {
                                if (r.success) {
                                    successes.push(r.event);
                                    if (r.type == "insert") { inserts += 1; }
                                    if (r.type == "update") { updates += 1; }
                                } else {
                                    failures.push({event: r.event, err: r.err});
                                }
                            });
                            console.log("Successfully dealt with", successes.length, 
                                "events (" + inserts, "new events,", updates, "existing events)");
                            console.log("Failed to deal with", failures.length, "events");
                            if (failures.length > 0) {
                                console.log("== Failures ==");
                                failures.forEach(function(f) {
                                    console.log("Event", f.event.summary, 
                                        "(" + f.event.uid + ", " + f.event.birminghamIOCalendarID + ")", 
                                        JSON.stringify(f.err));
                                });
                            }
                            console.log("== Events present in the Google calendar but not present in sources: %d ==", deletedUpstream.length);
                            deletedUpstream.forEach(function(duev) {
                                console.log(duev.summary + " (" + duev.id + ")", duev.start.dateTime);
                            });
                        });
                    });
                });
            });
        });
    });
}

if (require.main === module) {
    exports.mainJob();
}
