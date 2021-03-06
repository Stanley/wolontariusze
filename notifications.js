var r = require('rethinkdb')
var request = require('superagent')
var backdraft = require('backdraft-js')
var _ = require('lodash')
var schedule = require('node-schedule')

var env = process.env.NODE_ENV || 'development'
var config = require('./config.json')[env]
// Połączenie z sendgrid daje nam możliwość wysyłania emaili
var sendgrid = require('sendgrid')(process.env.SENDGRID_APIKEY)
var sendgrid_template = process.env.SENDGRID_TEMPLATE
var new_sg = sendgrid

// Lista zaplanowanych powiadomień o zakończeniu zgłoszeń do zadania
var jobs = {}

var notifyMentioned = function(title, body, author) {
  return function(err, cursor) {
    cursor.toArray(function(err, all) {

      // Anuluj jeżeli nie ma do kogo wysłać
      if(!all.length) { return }

      var request = new_sg.emptyRequest({
        method: 'POST',
        path: '/v3/mail/send',
        body: {
          personalizations: all.filter(function (volunteer) {return !!volunteer.email}).map(function (volunteer) {
              return {
                  to: [
                    {
                      email: volunteer.email
                    }
                  ],
                  subject: title,
                  substitutions: {
                    ":name": volunteer.first_name.toString(),
                  }
              }
          }),
          from: {
            email: 'portal@goradobra.pl',
            name: 'Portal Góra Dobra'
          },
          content: [
            {
              type: 'text/html',
              value: body,
            },
          ],
          reply_to: {
            email: author
          },
          categories: [
            'mention'
          ],
          template_id: sendgrid_template
        },
      })

      new_sg.API(request, function(error, response) {
        console.log('sendgrid:', JSON.stringify(error), response)
      })
    })
  }
}

r.connect(config.rethinkdb, function(err, conn) {
  r.table('Joints').changes()
    .run(conn, function(err, cursor) {

      cursor.each(function(err, change){ // Nowe zgłoszenie!
        var joint = change.new_val
        // Pobierz aktywność
        if (joint && joint.activity_id != 'news') {
          r.table('Activities').get(joint.activity_id)
            .run(conn, function(err, activity) {

              r.table('Volunteers').get(joint.created_by)
                .run(conn, function(err, author) { // Pobierz osobę która przypisała nas do zadania

                  r.table('Volunteers').get(activity.created_by)
                    .run(conn, function(err, owner) { // Pobierz osobę która stworzyła zadanie

                      if(!joint.is_canceled) {
                        var paragraphs = backdraft(activity.description, {
                          'BOLD': ['<strong>', '</strong>'],
                          'ITALIC': ['<i>', '</i>'],
                          'UNDERLINE': ['<u>', '</u>'],
                          'CODE': ['<span style="font-family: monospace">', '</span>']
                        }).join('<br/>')

                        var html = ['<p>:what_happend</p>' + paragraphs]

                        if(activity.updates) {
                          activity.updates.forEach(function(update) { // Dodaje wszystkie aktualizacje
                            //text.push(to_text(update.raw))
                            html.push(backdraft(update.raw, {
                              'BOLD': ['<strong>', '</strong>'],
                              'ITALIC': ['<i>', '</i>'],
                              'UNDERLINE': ['<u>', '</u>'],
                              'CODE': ['<span style="font-family: monospace">', '</span>']
                            }).join('<br/>'))
                          })
                        }

                        // Pobierz wolontariusza który się zgłosił
                        r.table('Volunteers').get(change.new_val.user_id).run(conn, function(err, volunteer) {
                          var has_joined
                          var was_joined

                          if (volunteer.nationality === "Polska") { // PL
                            subject = 'Zadanie: '+ activity.name
                            has_joined = 'Właśnie przypisałeś/aś się do zadania <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a> i bierzesz w nim udział. Dziękujemy.'
                            was_joined = author.first_name +' '+ author.last_name +' - przypisał/a Cię do zadania <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a>. Prosimy, potwierdź w nim swój udział mailem zwrotnym. Dziękujemy.'
                          } else { // EN
                            subject = 'Task: '+ activity.name
                            has_joined = 'You just signed up to the task <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a> and you are taking part in it. Thank you.'
                            was_joined = author.first_name +' '+ author.last_name +' - signed you up for the task <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a>. Please confirm your participation by replying to this email. Thank you.'
                          }

                          var personalizations = [{
                              to: [
                                {
                                  email: volunteer.email
                                }
                              ],
                              subject: subject,
                              substitutions: {
                                ":name": volunteer.first_name.toString(),
                                ":what_happend": joint.user_id === joint.created_by ? has_joined.toString() : was_joined.toString()
                              }
                          }]
                          if (volunteer.mail != owner.mail) {
                            personalizations[0].cc= [{email: owner.mail}]
                          }

                          var request = new_sg.emptyRequest({
                            method: 'POST',
                            path: '/v3/mail/send',
                            body: {
                              personalizations: personalizations,
                              from: {
                                email: 'portal@goradobra.pl',
                                name: 'Portal Góra Dobra'
                              },
                              content: [
                                {
                                  type: 'text/html',
                                  value: html.join('<hr/>'),
                                },
                              ],
                              reply_to: {
                                email: joint.user_id === joint.created_by ? owner.email : author.email
                              },
                              categories: [
                                'join'
                              ],
                              template_id: sendgrid_template
                            } 
                          })

                          new_sg.API(request, function(error, response) {
                            console.log('sendgrid:', JSON.stringify(error), response)
                          })
                        })
                      }

                      // Sprawdź czy nie został osiągnięty limit zgłoszeń
                      r.table('Joints')
                        .getAll(activity.id, { index: 'activity_id' })
                        .filter(r.row('is_canceled').eq(true).default(false).not())
                        .count()
                        .run(conn, function(err, count) {
                          var limit = parseInt(activity.limit, 10)
                          if(limit && count === limit) { // Ostatnie zgłoszenie - wyślij wiadomość autorowi zadania

                            var request = new_sg.emptyRequest({
                              method: 'POST',
                              path: '/v3/mail/send',
                              body: {
                                personalizations: [
                                  {
                                    to: [
                                      {
                                        email: owner.email
                                      }
                                    ],
                                    subject: 'Komplet zgłoszeń w zadaniu: '+ activity.name,
                                    substitutions: {
                                      ":name": owner.first_name.toString(),
                                    }
                                  },
                                ],
                                from: {
                                  email: 'portal@goradobra.pl',
                                  name: 'Portal Góra Dobra'
                                },
                                content: [
                                  {
                                    type: 'text/html',
                                    value: '<p>Komplet zgłoszeń!</p><p>Gratulacje - do Twojego zadania <a href="'+ config.base_url +'/zadania/'+ activity.id +'">"'+ activity.name +'"</a> właśnie zgłosiła się ostatnia osoba. Teraz możesz być w kontakcie z wszystkimi zgłoszonymi uczestnikami, dodając aktualizacje na stronie zadania. Możesz również zrobić to, wysyłając bezpośrednio do każdego wiadomość drogą mailową.</p>'
                                  },
                                ],
                                categories: [
                                  'full'
                                ],
                                template_id: sendgrid_template
                              } 
                            })

                            new_sg.API(request, function(error, response) {
                              console.log('sendgrid:', JSON.stringify(error), response)
                            })
                          }
                        })
                    })
                })
            })
        }
      })
      
    })

  r.table('Activities').changes()
    .filter(
      r.row('new_val').hasFields('updates').and(r.row('new_val')('updates').count().gt(r.row('old_val')('updates').count()).default(true))
    )
    .filter(
      r.row('new_val')('updates').count().gt(0)
    )
    .run(conn, function(err, changes) {
      changes.each(function(err, change){ // Nowa aktualizacja do aktywności

        var activity = change.new_val
        var update = activity.updates.pop()
        var html
        var subject = activity.name
        var mailCategory

        if (activity.id == 'news') {
          subject = "New information on the Mountain of Good (Góra Dobra) portal"
          html =  '<p>Nowe informacje na Górze Dobra. Zobacz <a href ="'+config.base_url+'/aktualnosci">Aktualności</a></p>'+
                  '<p>EN: There are new infomation at the Mountain of Good portal. See <a href ="'+config.base_url+'/aktualnosci">News</a></p>'
          mailCategory = 'newsletter'
        } else {
          html = '<p>PL: Nastąpiła najnowsza aktualizacja zadania <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a>, w którym uczestniczysz:</p><p>EN: There was an update to the task <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a> you are participating in:</p>'
          mailCategory = 'activity_update'
        }


        html += backdraft(update.raw, {
          'BOLD': ['<strong>', '</strong>'],
          'ITALIC': ['<i>', '</i>'],
          'UNDERLINE': ['<u>', '</u>'],
          'CODE': ['<span style="font-family: monospace">', '</span>']
        }).join('<br/>')

        r.table('Volunteers').get(update.created_by)
          .run(conn, function(err, author) {

            // Wzmianki w aktualizacji
            var entities = update.raw.entityMap || []
            var receivers = _.compact(_.map(entities, function(map) {
              return map.data.mention && map.data.mention.id
            }))

            var body = backdraft(update.raw, {
              'BOLD': ['<strong>', '</strong>'],
              'ITALIC': ['<i>', '</i>'],
              'UNDERLINE': ['<u>', '</u>'],
              'CODE': ['<span style="font-family: monospace">', '</span>']
            }).join('<br/>')

            var title = ''
            var mention_html = ''
            if (activity.id == 'news') {
              title= 'New information on the Mountain of Good (Góra Dobra) portal (You were mentioned)'
              mention_html = '<p>PL: '+ author.first_name +' '+ author.last_name +' wspomina Cię w aktualności na Górze Dobra. Zobacz <a href ="'+config.base_url+'/aktualnosci">Aktualności</a></p><p>'+body+'</p>'
                             '<p>EN: You were mentioned by'+ author.first_name +' '+ author.last_name +' in News at the Mountain of Good portal. See <a href ="'+config.base_url+'/aktualnosci">News</a></p><p>'+body+'</p>'
            } else {
              title= author.first_name +' '+ author.last_name +' wspomina Cię w zadaniu \"'+ activity.name +'\"'
              mention_html = '<p>'+ author.first_name +' '+ author.last_name +' wspomina Cię w aktualizacji do zadania.</p><p>'+ body +'</p><p>Kliknij w poniższy link, aby przejść do zadania: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a>.</p>'
            }

            var table = r.table('Volunteers')
            table.getAll.apply(table, receivers) // Pobierz wolontariuszy
              .run(conn, notifyMentioned(title, mention_html, author.email))

            // Powiadom resztę (TODO: usuń wspomnianych)
            r.table('Joints')
              .getAll(change.new_val.id, { index: 'activity_id' })
              .filter(function(x) {
                // Upewnij się że zgłoszenie nie zostało anulowane
                return x.hasFields('is_canceled').not()
              }, { default: true })
              .eqJoin('user_id', r.table('Volunteers'))
              .run(conn, function(err, cursor) {

                cursor.toArray(function(err, all_volunteers) {
                  var size = all_volunteers.length
                  if(!size) { return } // Nie ma do kogo wysłać

                  // Podziel listę odbiorców na segmenty po 1000 adresów
                  _.times(Math.ceil(size / 1000), function() {
                    // Lista 1000 osbiorców
                    var volunteers = all_volunteers.splice(0, 1000)
                    var request = new_sg.emptyRequest({
                      method: 'POST',
                      path: '/v3/mail/send',
                      body: {
                        personalizations: volunteers.filter(function (volunteer) {return !!volunteer.right.email}).map(function (volunteer) {
                          return {
                              to: [
                                {
                                  email: volunteer.right.email
                                }
                              ],
                              subject: subject,
                              substitutions: {
                                ":name": volunteer.right.first_name.toString(),
                              }
                          }
                        }),
                        from: {
                          email: 'portal@goradobra.pl',
                          name: 'Portal Góra Dobra'
                        },
                        content: [
                          {
                            type: 'text/html',
                            value: html,
                          },
                        ],
                        reply_to: {
                          email: author.email
                        },
                        categories: [
                          mailCategory.toString()
                        ],
                        template_id: sendgrid_template
                      },
                    })

                    new_sg.API(request, function(error, response) {
                      console.log('sendgrid:', JSON.stringify(error), response)
                    })
                  })
                })
              })
          })
      })
    })

  r.table('Volunteers').changes()
    .filter(r.row('old_val')('approved').default(false).eq(true).not().and(r.row('new_val')('approved').eq(true)))
    .run(conn, function(err, cursor) {
      cursor.each(function(err, change){ // Wolontariusz został "approved"
        var row = change.new_val
        var token = row.access_tokens[row.access_tokens.length-1]
        var url = config.base_url +'/invitation?apikey='+ token.token
        var html
        var subject

        if (row.nationality === "Polska") { // PL
          subject = 'Zaproszenie do Góry Dobra!'
          html = '<p>Chcemy zaprosić Cię do Góry Dobra - portalu dla wolontariuszy, który będzie równocześnie naszą główną platformą komunikacji podczas Światowych Dni Młodzieży w Krakowie oraz narzędziem do organizacji projektów i wydarzeń.</p><p>To tutaj chcemy stworzyć środowisko młodych i zaangażowanych ludzi, dzielić się tym, co robimy i przekazywać Ci ważne informacje o ŚDM i zadaniach, jakie czekają na realizację.</p><p>Dzięki Górze Dobra będziesz mógł pochwalić się efektami swojej pracy. W tym też miejscu będziesz miał możliwość zobaczenia i dzielenia się z innymi informacjami o tym, jak dużo serca, i aktywności wolontariackiej dajesz na rzecz Światowych Dni Młodzieży w Krakowie.</p><p>Aby aktywować swoje konto kliknij w poniższy link:</p><p><a href="'+ url +'">'+ url +'</a></p><p>WAŻNE! Link, jaki otrzymujesz teraz do zalogowania, jest aktywny tylko przez 72h. W wypadku jakichkolwiek problemów bądź pytań, prosimy o kontakt na: kontakt@goradobra.pl.</p><p>Nie zwlekaj ani chwili dłużej i zostań już dziś Wolontariuszem ŚDM Kraków 2016.</p>'
        } else { // EN
          subject = 'Invitation to Mountain of Good portal'
          html = '<p>We would like to invite you to the “Mountain of Good” - a portal for volunteers. The portal will be the main means of communication during the World Youth Days in Krakow and a tool for managing projects and events.  This is a place for building a community of young and engaged people, for sharing what we do, for providing you important news regarding World Youth Days, and for sharing information about tasks waiting for volunteers.</p><p> Thanks to the “Mountain of Good” you will be able to share the results of your volunteer work. You will be able to see and share how much heart and energy you and the other volunteers are giving for the World Youth Days Krakow 2016.</p><p> To activate your account please click on the following link:</p> <p><a href="'+ url +'">'+ url +'</a></p> <p>Important! The link you have just received is valid only for 72 hours. In case of any problems or questions please contact us using email - kontakt@goradobra.pl.</p><p>Ps. Want to get to know other WYD volunteers? Sign up now, and join this task (by clicking blue "I volunteer" button): <a href="https://wolontariusze.krakow2016.com/zadania/a2b519c6-0f9f-4b05-a0e5-3a81cf003f13">https://wolontariusze.krakow2016.com/zadania/a2b519c6-0f9f-4b05-a0e5-3a81cf003f13</a></p>'
        }

        var request = new_sg.emptyRequest({
          method: 'POST',
          path: '/v3/mail/send',
          body: {
            personalizations: [
              {
                to: [
                  {
                    email: row.email
                  }
                ],
                subject: subject,
                substitutions: {
                  ":name": row.first_name.toString(),
                }
              },
            ],
            from: {
              email: 'portal@goradobra.pl',
              name: 'Portal Góra Dobra'
            },
            content: [
              {
                type: 'text/html',
                value: html,
              }
            ],
            categories: [
              'invitation'
            ],
            template_id: sendgrid_template
          } 
        })

        new_sg.API(request, function(error, response) {
          console.log('sendgrid:', JSON.stringify(error), response)
        })

      })
    })

  r.table('Volunteers').changes()
    .filter(r.row('old_val')('is_admin').default(false).eq(true).not().and(r.row('new_val')('is_admin').eq(true)))
    .run(conn, function(err, cursor) {
      cursor.each(function(err, change){ // Wolontariusz został adminem
        var row = change.new_val

        r.table('Volunteers').get(row.promoted_by)
          .run(conn, function(err, admin) { // Pobierz autora zmiany

            var html = '<p>'+ admin.first_name +' '+ admin.last_name +' właśnie nadał/a Ci specjalne uprawnienia koordynatora, dzięki którym masz obecnie dostęp do bazy danych wszystkich wolontariuszy w systemie m.in. danych kontaktowych, umiejętności, doświadczenie itp.</p><p> Równocześnie informujemy, że otrzymując dostęp jako koordynator, jesteś zobowiązany/a do zachowania w tajemnicy i nie ujawniania osobom trzecim otrzymanych tu informacji i danych o charakterze poufnym, w tym danych osobowych oraz sposobów ich zabezpieczenia, do których będziesz mieć dostęp w związku z wykonywaniem zadań koordynatora wolontariuszy ŚDM Kraków 2016 zarówno w trakcie ich wykonywania, jak i po ich ustaniu. *<br /> Administratorem powyższych danych jest Archidiecezja Krakowska.</p> <p>* Zgodnie z przepisami Rozdziału 8. Ustawy o ochronie danych osobowych (Dz. U. z 2002 r. Nr 101, poz. 926 ze zm.) w wypadku naruszenia powyższych przepisów ustawy, ponoszona jest odpowiedzialność karna.</p>'

            var request = new_sg.emptyRequest({
              method: 'POST',
              path: '/v3/mail/send',
              body: {
                personalizations: [
                  {
                    to: [
                      {
                        email: row.email
                      }
                    ],
                    cc: [
                      {
                        email: 'portal@goradobra.pl'
                      }
                    ],
                    subject: 'Witaj w gronie koordynatorów wolontariuszy na Górze Dobra!',
                    substitutions: {
                      ":name": row.first_name.toString(),
                    }
                  },
                ],
                from: {
                  email: 'portal@goradobra.pl',
                  name: 'Portal Góra Dobra'
                },
                content: [
                  {
                    type: 'text/html',
                    value: html
                  },
                ],
                categories: [
                  'admin'
                ],
                template_id: sendgrid_template
              } 
            })

            new_sg.API(request, function(error, response) {
              console.log('sendgrid:', JSON.stringify(error), response)
            })
          })
      })
    })

  r.table('Volunteers').changes()
    .filter(r.row('old_val')('is_leader').default(false).eq(true).not().and(r.row('new_val')('is_leader').eq(true)))
    .run(conn, function(err, cursor) {
      cursor.each(function(err, change){ // Wolontariusz został liderem
        var row = change.new_val

        r.table('Volunteers').get(row.promoted_to_leader_by)
          .run(conn, function(err, admin) { // Pobierz autora zmiany

            var html = '<p>'+ admin.first_name +' '+ admin.last_name +' właśnie nadał/a Ci specjalne uprawnienia koordynatora, dzięki którym możesz tworzyć nowe aktywności w Banku Pracy</p>'

            var request = new_sg.emptyRequest({
              method: 'POST',
              path: '/v3/mail/send',
              body: {
                personalizations: [
                  {
                    to: [
                      {
                        email: row.email
                      }
                    ],
                    cc: [
                      {
                        email: 'portal@goradobra.pl'
                      }
                    ],
                    subject: 'Witaj w gronie liderów na Górze Dobra!',
                    substitutions: {
                      ":name": row.first_name.toString(),
                    }
                  },
                ],
                from: {
                  email: 'portal@goradobra.pl',
                  name: 'Portal Góra Dobra'
                },
                content: [
                  {
                    type: 'text/html',
                    value: html
                  },
                ],
                categories: [
                  'admin'
                ],
                template_id: sendgrid_template
              } 
            })

            new_sg.API(request, function(error, response) {
              console.log('sendgrid:', JSON.stringify(error), response)
            })
          })
      })
    })

  // Wzmianki w komentarzach na profilu wolontariuszy
  r.table('Comments').filter(r.row.hasFields({
    raw: {
      entityMap: {'0': true} // Tylko te które mają jakąś wzmiankę
    },
    volunteerId: true,
    adminId: true
  })).changes()
    .filter(
      r.row('new_val').hasFields('adminId') // jeśli komentarz usunięty, to pomiń
    )
    .run(conn, function(err, cursor){
      cursor.each(function(err, change){ // Nowy komentarz

        var comment = change.new_val
        var table = r.table('Volunteers')

        table.get(comment.adminId)
          .run(conn, function(err, author) { // Pobierz autora komentarza
            table.get(comment.volunteerId)
              .run(conn, function(err, volunteer) { // Pobierz wolontariusza

                // Identyfikatory odbiorców powiadomienia
                var entities = comment.raw.entityMap || []
                var receivers = _.compact(_.map(entities, function(map) {
                  return map.data.mention && map.data.mention.id
                }))
                var title = author.first_name +' '+ author.last_name +' przesyła Ci wiadomość o wolontariuszu'
                var body = '<p>'+ author.first_name +' '+ author.last_name +' wspomnia Cię w komentarzu do profilu wolontariusza.</p><p>Kliknij w poniższy link, aby przejść do profilu: <a href="'+ config.base_url +'/wolontariusz/'+ volunteer.id +'">'+ volunteer.first_name +' '+ volunteer.last_name +'</a>.</p>'

                table.getAll.apply(table, receivers)
                  .filter(r.row('is_admin').eq(true)) // Powiadomienia dostają tylko koordynatorzy!
                  .run(conn, notifyMentioned(title, body, author.email)) // Pobierz wolontariusza
              })
          })
      })
    })

  // Powiadomienia w komentarzach do aktywności
  r.table('Comments').filter(r.row.hasFields({
    raw: {
      entityMap: {'0': true} // Tylko te które mają jakąś wzmiankę
    },
    activityId: true,
    adminId: true
  })).changes()
    .filter(
      r.row('new_val').hasFields('adminId') // jeśli komentarz usunięty, to pomiń
    )
    .run(conn, function(err, cursor){
      cursor.each(function(err, change){ // Nowy komentarz

        var comment = change.new_val
        var tableActivities = r.table('Activities')
        var tableVolunteers = r.table('Volunteers')

        tableVolunteers.get(comment.adminId)
          .run(conn, function(err, author) { // Pobierz autora komentarza
            tableActivities.get(comment.activityId)
              .run(conn, function(err, activity) { // Pobierz dane aktywności

                // Identyfikatory odbiorców powiadomienia
                var entities = comment.raw.entityMap || []
                var receivers = _.compact(_.map(entities, function(map) {
                  return map.data.mention && map.data.mention.id
                }))
                var title = 'You were mentioned in a comment on the Mountain of Good (Góra Dobra) portal'
                var commentBody = backdraft(comment.raw, {
                    'BOLD': ['<strong>', '</strong>'],
                    'ITALIC': ['<i>', '</i>'],
                    'UNDERLINE': ['<u>', '</u>'],
                    'CODE': ['<span style="font-family: monospace">', '</span>']
                  }).join('<br/>')
                var body = '<p>PL: '+ author.first_name +' '+ author.last_name +' wspomina Cię w komentarzu do aktywności.</p><p>Kliknij w poniższy link, aby przejść do aktywności: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name+'</a>.</p>'+
                          '<p>EN: '+ author.first_name +' '+ author.last_name +' mentioned you in a comment for an Activity</p><p>Click the link to go to Activity: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name+'</a>.</p>'+
                          '<p>'+commentBody+'</p>'

                tableVolunteers.getAll.apply(tableVolunteers, receivers)
                  .run(conn, notifyMentioned(title, body, author.email)) // Pobierz wolontariusza
              })
          })
      })
    })

  // Informacja o nowym komentarzu dla autora zadania
  r.table('Comments').filter(r.row.hasFields({
    activityId: true
  })).changes()
    .filter(
      r.row('new_val').count().gt(r.row('old_val').count()).default(true)
    )
    .filter(
      r.row('new_val').count().gt(0)
    )
    .run(conn, function(err, cursor){
      cursor.each(function(err, change){ // Nowy komentarz

        var comment = change.new_val
        var tableActivities = r.table('Activities')
        var tableVolunteers = r.table('Volunteers')

        tableVolunteers.get(comment.adminId)
          .run(conn, function(err, author) { // Pobierz autora komentarza
            tableActivities.get(comment.activityId)
              .run(conn, function(err, activity) { // Pobierz dane aktywności
                tableVolunteers.get(activity.created_by)
                  .run(conn, function(err, activityAuthor) { // Pobierz dane twórcy aktywności

                    var title = 'Nowy komentarz do aktywności stworzonej przez Ciebie'
                    var commentBody = backdraft(comment.raw, {
                        'BOLD': ['<strong>', '</strong>'],
                        'ITALIC': ['<i>', '</i>'],
                        'UNDERLINE': ['<u>', '</u>'],
                        'CODE': ['<span style="font-family: monospace">', '</span>']
                      }).join('<br/>')
                    var body = '<p>PL: '+ author.first_name +' '+ author.last_name +' dodał komentarz do aktywności.</p><p>Kliknij w poniższy link, aby przejść do aktywności: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name+'</a>.</p>'+
                              '<p>EN: '+ author.first_name +' '+ author.last_name +' added a comment for an Activity</p><p>Click the link to go to Activity: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name+'</a>.</p>'+
                              '<p>'+commentBody+'</p>'
                    
                    var request = new_sg.emptyRequest({
                        method: 'POST',
                        path: '/v3/mail/send',
                        body: {
                          personalizations: [
                            {
                                to: [
                                  {
                                    email: activityAuthor.email
                                  }
                                ],
                                subject: title,
                                substitutions: {
                                  ":name": activityAuthor.first_name.toString(),
                                }
                            }
                          ],
                          from: {
                            email: 'portal@goradobra.pl',
                            name: 'Portal Góra Dobra'
                          },
                          content: [
                            {
                              type: 'text/html',
                              value: body,
                            },
                          ],
                          categories: [
                            'new_comment'
                          ],
                          template_id: sendgrid_template
                        },
                      })

                      new_sg.API(request, function(error, response) {
                        console.log('sendgrid:', JSON.stringify(error), response)
                      })
                  })
              })
          })
      })
    })

  // Wzmianki w aktywnościach
  r.table('Activities').filter(r.row.hasFields({
    description: {
      entityMap: {'0': true} // Tylko te które mają jakąś wzmiankę
    }
  })).changes().filter(r.row.hasFields('old_val').not()) // Tylko te które zostały właśnie stworzone (a nie edytowane)
    .run(conn, function(err, changes) {
      changes.each(function(err, change){ // Nowy komentarz
        var activity = change.new_val
        var table = r.table('Volunteers')

        table.get(activity.created_by)
          .run(conn, function(err, author) { // Pobierz autora zadania

            // Identyfikatory odbiorców powiadomienia
            var entities = activity.description.entityMap || []
            var receivers = _.compact(_.map(entities, function(map) {
              return map.data.mention && map.data.mention.id
            }))

            table.getAll.apply(table, receivers)
              .run(conn, function(err, cursor) { // Pobierz wolontariuszy
                cursor.toArray(function(err, all) {

                  var body = backdraft(activity.description, {
                    'BOLD': ['<strong>', '</strong>'],
                    'ITALIC': ['<i>', '</i>'],
                    'UNDERLINE': ['<u>', '</u>'],
                    'CODE': ['<span style="font-family: monospace">', '</span>']
                  }).join('<br/>')

                  var html = '<p>'+ author.first_name +' '+ author.last_name +' wspomnia Cię w zadaniu.</p><p>'+ body +'</p><p>Kliknij w poniższy link, aby zobaczyć szczegóły: <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a>.</p>'

                  var request = new_sg.emptyRequest({
                    method: 'POST',
                    path: '/v3/mail/send',
                    body: {
                      personalizations: all.filter(function (volunteer) {return !!volunteer.email}).map(function (volunteer) {
                          return {
                              to: [
                                {
                                  email: volunteer.email
                                }
                              ],
                              subject: author.first_name +' '+ author.last_name +' wspomina Cię w zadaniu \"'+ activity.name +'\"',
                              substitutions: {
                                ":name": volunteer.first_name.toString(),
                              }
                          }
                      }),
                      from: {
                        email: 'portal@goradobra.pl',
                        name: 'Portal Góra Dobra'
                      },
                      content: [
                        {
                          type: 'text/html',
                          value: body,
                        },
                      ],
                      reply_to: {
                        email: author
                      },
                      categories: [
                        'mention'
                      ],
                      template_id: sendgrid_template
                    },
                  })

                  new_sg.API(request, function(error, response) {
                    console.log('sendgrid:', JSON.stringify(error), response)
                  })

                })
              })
          })
      })
    })

  var notifyEnd = function(activity) {
    r.table('Volunteers').get(activity.created_by)
      .run(conn, function(err, author) {
        var html = '<p>Właśnie upłynął czas zgłaszania się do Twojego zadania <a href="'+ config.base_url +'/zadania/'+ activity.id +'">'+ activity.name +'</a> i nie jest ono już widoczne w banku pracy.</p><p>Nie zapomnij powiadomić zgłoszonych wolontariuszy o szczegółach ich zadań. Możesz zrobić to wysyłając wiadomość  do każdego z osobna lub do wszystkich drogą e-mailową; bądź też poprzez umieszczenie aktualizacji do zadania na Górze Dobra.</p><p>Jeśli nie masz kompletu potrzebnych Ci do zadania osób, możesz przedłużyć czas zgłaszania edytując jego datę.</p>'

        var request = new_sg.emptyRequest({
          method: 'POST',
          path: '/v3/mail/send',
          body: {
            personalizations: [
              {
                to: [
                  {
                    email: author.email,
                  },
                ],
                subject: 'Upłynął czas zgłoszeń do Twojego zadania!',
                substitutions: {
                  ":name": author.first_name.toString()
                }
              },
            ],
            from: {
              email: 'portal@goradobra.pl',
              name: 'Portal Góra Dobra'
            },
            content: [
              {
                type: 'text/html',
                value: html,
              },
            ],
            categories: [
              'finish'
            ],
            template_id: sendgrid_template
          }
        })

        new_sg.API(request, function(error, response) {
          console.log('sendgrid:', JSON.stringify(error), response)
        })
      })
  }

  var activities = r.table('Activities')
    .filter(r.row('is_archived').default(false).eq(true).not())
    .filter(r.row('datetime').gt(r.now().toISO8601())) // Tylko przyszłe zadania

  // Wczytaj wszystkie aktywne zadania
  activities
    .run(conn, function(err, cursor) {
      cursor.each(function(err, activity){
        if(!activity.datetime) { return }
        // Dodaj zlecenie wysłania powiadomenia o zakończeniu
        var job = schedule.scheduleJob(new Date(activity.datetime), function(act){
          notifyEnd(act)
        }.bind(null, activity))
        jobs[activity.id] = job
      })
    })

  // Monitoruj zmiany w aktywnych zadaniach
  activities.changes()
    .run(conn, function(err, cursor) {
      cursor.each(function(err, change){
        var activity = change.new_val
        var job = jobs[activity.id]
        if(job) {
          // Usuń lub zaktualizuj zlecenie
          job.cancel()
        }
        // Brak terminu zgłoszeń
        if(!activity.datetime) { return }
        // Dodaj zlecenie wysyłania powiadomienia
        job = schedule.scheduleJob(new Date(activity.datetime), function(act){
          notifyEnd(act)
        }.bind(null, activity))
        jobs[activity.id] = job
      })
    })

//   // Informuje API Eventory o zmianach w grupach wolontariusza
//   r.table('Volunteers').changes()
//     .filter(r.row('new_val')('tags').eq(r.row('old_val')('tags').default([])).not())
//     .run(conn, function(err, cursor) {
//       cursor.each(function(err, change){
//         var row = change.new_val
//         request
//           .put('https://eventory.cc/webapi/v1/sdm/sync')
//           .send({volunteer_id: row.id, groups: row.tags})
//           .set('X-Operator-Api-Token', process.env.EVENTORY_API)
//           .end()
//       })
//     })

//   // Informuje API Eventory o zmianach w zdjęciu profilowym
//   r.table('Volunteers').changes()
//     .filter(r.row('new_val')('profile_picture_url').eq(r.row('old_val')('profile_picture_url').default('')).not())
//     .run(conn, function(err, cursor) {
//       cursor.each(function(err, change){
//         var row = change.new_val
//         request
//           .put('https://eventory.cc/webapi/v1/sdm/sync')
//           .send({
//             volunteer_id: row.id,
//             photo: row.profile_picture_url
//           })
//           .set('X-Operator-Api-Token', process.env.EVENTORY_API)
//           .end()
//       })
//     })
})
